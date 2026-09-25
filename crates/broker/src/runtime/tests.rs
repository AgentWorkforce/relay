use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::fleet_wire::{BrokerToRelaycast, Deliver, DeliveryMode, FLEET_WIRE_VERSION};
use crate::ids::{
    AgentId, ChannelName, DeliveryId, EventId, MessageTarget, WorkerName, WorkspaceAlias,
    WorkspaceId,
};
use crate::listen_api::{listen_api_router_with_auth, ListenApiConfig, ListenApiRequest};
use crate::node_control::{FleetControlCommand, FleetDeliveryBook};
use crate::protocol::{
    AgentSpec, BrokerEvent, DeliveryReadAckStatus, HarnessReleasePolicy, HeadlessHarnessConfig,
    HeadlessHarnessDriver, MessageInjectionMode, NativeHarnessConfig, ProtocolEnvelope,
    RelayDelivery, ResolvedHarnessConfig,
};
use crate::replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY};
use crate::telemetry::TelemetryClient;
use crate::worker::{
    spawn_worker_writer, AgentWorkState, WorkerEvent, WorkerHandle, WorkerRegistry,
};
use crate::{
    broker::injection_format::format_injection,
    util::{
        ansi::{floor_char_boundary, strip_ansi},
        terminal::{
            detect_bypass_permissions_prompt, detect_claude_trust_prompt, is_auto_suggestion,
            is_bypass_selection_menu, is_in_editor_mode,
        },
    },
};
use axum::{body::to_bytes, body::Body, http::Request};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tower::ServiceExt;
use uuid::Uuid;

use super::api::{can_spawn_without_preregistration, recipient_name_for_reachability};
use super::{
    apply_exit_after_task_instruction, build_agent_state_transition_event,
    build_http_api_spawn_spec, build_thread_infos, channels_from_csv,
    clear_pending_delivery_if_event_matches, continuity_dir, default_observer_token_scopes,
    delivery_read_ack_is_relaycast_message, delivery_retry_interval,
    dispose_pending_fleet_ack_prefix, drop_pending_for_worker, emit_delivery_attempt_outcome,
    emit_dropped_delivery_failures, ensure_ephemeral_paths, extract_mcp_message_ids,
    http_api_event_emit_timeout, http_api_local_delivery_timeout, http_api_relaycast_send_timeout,
    is_relaycast_self_control_target, is_unknown_worker_error_message, load_dead_letters,
    load_pending_deliveries, mark_delivery_read_ack, mark_delivery_read_ack_with_timeout,
    mint_or_recover_observer_token, normalize_channel, normalize_initial_task, normalize_sender,
    parse_sort_key_from_raw_timestamp, pending_message_counts, persist_dead_letters_on_shutdown,
    persist_pending_on_shutdown, queue_inbound_for_delivery_mode,
    relaycast_spawn_control_dedup_key, relaycast_ws_should_apply_local_spawn_echo_dedup,
    relaycast_ws_spawn_token, requeue_dead_letter, resolve_exit_after_task, resolve_workspace,
    retry_pending_delivery, save_dead_letters, seed_supplied_agent_token, send_broker_event,
    sender_is_dashboard_label, should_clear_pending_delivery_for_event,
    synthetic_delivery_read_ack_reason, take_pending_for_worker, try_inject_pending_relay_message,
    AgentRuntime, BrokerRuntime, DeadLetterEntry, DeadLetterStore, DeliveryAttemptOutcome,
    InboundContext, InboundQueueOutcome, ObserverTokenMintError, ObserverTokenMintOutcome,
    PendingDelivery, PendingDeliveryStore, ProtocolHeadlessProvider, RelayWorkspace, RuntimePaths,
    TypedThreadMessage, MAX_DEAD_LETTERS, MAX_DELIVERY_RETRIES,
};
use crate::dedup::DedupCache;
use crate::relaycast::{
    format_worker_preregistration_error, RelaycastHttpClient, RelaycastRegistrationError, WsControl,
};
use crate::types::{
    InboundDeliveryMode, InboundDeliveryState, PendingRelayMessage, RelaycastDeliveryReceipt,
};
use relaycast::ObserverScope;

fn env_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

async fn make_worker_registry_with_worker(name: &str) -> WorkerRegistry {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let mut registry = WorkerRegistry::new(
        tx.clone(),
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let mut child = tokio::process::Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("test worker process should spawn");
    let stdin = child.stdin.take().expect("test worker stdin should exist");
    let generation = Uuid::new_v4();
    let (command_tx, command_rx) = mpsc::channel(128);
    spawn_worker_writer(tx, WorkerName::from(name), generation, stdin, command_rx);
    registry.workers.insert(
        WorkerName::from(name),
        WorkerHandle {
            generation,
            spec: AgentSpec {
                name: WorkerName::from(name),
                runtime: AgentRuntime::Pty,
                provider: None,
                cli: Some("cat".to_string()),
                session_id: None,
                harness_config: None,
                model: None,
                cwd: None,
                team: None,
                shadow_of: None,
                shadow_mode: None,
                args: Vec::new(),
                channels: Vec::new(),
                restart_policy: None,
            },
            parent: None,
            workspace_id: Some(WorkspaceId::new("ws_demo")),
            child,
            command_tx,
            harness_pid: None,
            spawned_at: Instant::now(),
            // Ready, so the orphan sweep's readiness deadline never applies to
            // these fixtures.
            ready_at: Some(Instant::now()),
            last_activity_at: Instant::now(),
            context_budget_pct: None,
            state: AgentWorkState::Working,
            exit_reason: None,
        },
    );
    registry
}

/// A worker whose command channel accepts frames but never completes them —
/// no writer task ever drains `command_rx`, so `deliver()` hangs forever.
/// Models a handoff that outlives `retry_interval` deterministically (no
/// timing race): the receiver stays alive (a dropped one would fail the
/// send instead of hanging it), so the send always succeeds and the
/// subsequent completion wait never returns on its own.
async fn make_worker_registry_with_stalled_worker(name: &str) -> WorkerRegistry {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let mut registry = WorkerRegistry::new(
        tx,
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let child = tokio::process::Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("test worker process should spawn");
    let generation = Uuid::new_v4();
    let (command_tx, command_rx) = mpsc::channel(128);
    // Deliberately leaked, not spawned as a writer: keeps the receiver alive
    // (so sends succeed) without anything ever draining it.
    std::mem::forget(command_rx);
    registry.workers.insert(
        WorkerName::from(name),
        WorkerHandle {
            generation,
            spec: AgentSpec {
                name: WorkerName::from(name),
                runtime: AgentRuntime::Pty,
                provider: None,
                cli: Some("cat".to_string()),
                session_id: None,
                harness_config: None,
                model: None,
                cwd: None,
                team: None,
                shadow_of: None,
                shadow_mode: None,
                args: Vec::new(),
                channels: Vec::new(),
                restart_policy: None,
            },
            parent: None,
            workspace_id: Some(WorkspaceId::new("ws_demo")),
            child,
            command_tx,
            harness_pid: None,
            spawned_at: Instant::now(),
            ready_at: Some(Instant::now()),
            last_activity_at: Instant::now(),
            context_budget_pct: None,
            state: AgentWorkState::Working,
            exit_reason: None,
        },
    );
    registry
}

async fn cleanup_worker_registry(mut registry: WorkerRegistry) {
    for handle in registry.workers.values_mut() {
        let _ = handle.child.start_kill();
        let _ = handle.child.wait().await;
    }
}

struct WorkerEventRuntimeFixture {
    runtime: BrokerRuntime,
    api_tx: mpsc::Sender<ListenApiRequest>,
    fleet_control_rx: mpsc::Receiver<FleetControlCommand>,
    _sdk_out_rx: mpsc::Receiver<ProtocolEnvelope<Value>>,
    _temp_dir: tempfile::TempDir,
}

#[tokio::test]
async fn owned_cleanup_exhaustion_signals_once_and_explicit_release_restarts() {
    use crate::listen_api::ListenApiRequest;
    use std::io::Write;
    use std::sync::Arc;
    use tokio::sync::oneshot;
    use tracing::instrument::WithSubscriber;
    #[derive(Clone)]
    struct LogWriter(Arc<Mutex<Vec<u8>>>);
    impl Write for LogWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let logs = Arc::new(Mutex::new(Vec::new()));
    let sink = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || LogWriter(sink.clone()))
        .finish();
    async {
        let (tx, _rx) = mpsc::channel(16);
        let registry = WorkerRegistry::new(
            tx,
            Vec::new(),
            PathBuf::from("/tmp/cleanup-exhaustion-fixture"),
            Instant::now(),
        );
        let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
        let name = WorkerName::from("exhausted-owner");
        let generation = Uuid::new_v4();
        let http = RelaycastHttpClient::new(
            Some("http://127.0.0.1:1".into()),
            "rk_live_fixture",
            "broker",
            "codex",
        );
        http.seed_agent_token(&name, "owned-token");
        fixture
            .runtime
            .workers
            .owned_spawn_generations
            .insert(name.clone(), (generation, http));
        fixture
            .runtime
            .fleet_delivery_book
            .bind_authoritative_identity(name.to_string(), "original-agent-id");
        let (reply, _released) = oneshot::channel();
        fixture
            .runtime
            .handle_api_request(ListenApiRequest::Release {
                name: name.clone(),
                reason: None,
                expected_generation: Some(generation.to_string()),
                delete_identity: true,
                reply,
            })
            .await;
        for attempt in 1..=5 {
            loop {
                if let FleetControlCommand::DeregisterAgent { reply, .. } =
                    fixture.fleet_control_rx.recv().await.unwrap()
                {
                    reply.send(Err("fixture rejection".into())).unwrap();
                    break;
                }
            }
            let before = Instant::now();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    fixture.runtime.reconcile_identity_cleanups().await;
                    if fixture.runtime.workers.identity_cleanups[&name].retry_at > before {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("cleanup rejection should be reconciled");
            assert_eq!(
                fixture.runtime.workers.identity_cleanups[&name].attempts,
                attempt
            );
            fixture
                .runtime
                .workers
                .identity_cleanups
                .get_mut(&name)
                .unwrap()
                .retry_at = Instant::now();
            if attempt < 5 {
                fixture.runtime.reconcile_identity_cleanups().await;
            }
        }
        for _ in 0..6 {
            fixture.runtime.reconcile_identity_cleanups().await;
        }
        while let Ok(command) = fixture.fleet_control_rx.try_recv() {
            assert!(
                !matches!(command, FleetControlCommand::DeregisterAgent { .. }),
                "exhaustion must stop automatic retries"
            );
        }
        assert!(fixture
            .runtime
            .workers
            .owned_spawn_generations
            .contains_key(&name));
        let (reply, retried) = oneshot::channel();
        fixture
            .runtime
            .handle_api_request(ListenApiRequest::Release {
                name: name.clone(),
                reason: None,
                expected_generation: Some(generation.to_string()),
                delete_identity: true,
                reply,
            })
            .await;
        fixture.runtime.reconcile_identity_cleanups().await;
        loop {
            if let FleetControlCommand::DeregisterAgent { request, reply } =
                fixture.fleet_control_rx.recv().await.unwrap()
            {
                assert_eq!(request.agent_id, "original-agent-id");
                reply.send(Err("sixth fixture rejection".into())).unwrap();
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        fixture.runtime.reconcile_identity_cleanups().await;
        assert!(retried.await.unwrap().is_err());
        assert_eq!(fixture.runtime.workers.identity_cleanups[&name].attempts, 1);
        let text = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
        assert_eq!(
            text.matches("owned identity cleanup retries exhausted")
                .count(),
            1
        );
        assert!(text.contains("ERROR"));
        assert!(text.contains("original-agent-id"));
        assert!(text.contains(&generation.to_string()));
        assert!(text.contains("explicit generation-matched release retry"));
    }
    .with_subscriber(subscriber)
    .await;
}

#[tokio::test]
async fn owned_cleanup_waits_off_actor_and_retains_custody_until_confirmed() {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{Method::POST, MockServer};
    use tokio::sync::oneshot;
    let server = MockServer::start();
    let release = server.mock(|when, then| {
        when.method(POST)
            .path("/v1/agents/release")
            .json_body_partial(json!({"name":"retired", "delete_agent":true}).to_string());
        then.status(200)
            .json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    let registry = make_worker_registry_with_worker("unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let cleanup_journal = fixture._temp_dir.path().join("owned-cleanups.json");
    fixture.runtime.workers.owned_cleanup_journal = Some(cleanup_journal.clone());
    let name = WorkerName::from("retired");
    let generation = Uuid::new_v4();
    let http = RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    http.seed_agent_token(&name, "owned-token");
    fixture
        .runtime
        .workers
        .owned_spawn_generations
        .insert(name.clone(), (generation, http));
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(name.to_string(), "retired-id".to_string());
    fixture.runtime.fleet_inventory.insert(
        name.clone(),
        crate::fleet_wire::InventoryAgent {
            name: name.to_string(),
            agent_id: "retired-id".to_string(),
            invocation_id: None,
            session_ref: None,
        },
    );
    let (reply, mut released) = oneshot::channel();
    tokio::time::timeout(
        Duration::from_millis(500),
        fixture
            .runtime
            .handle_api_request(ListenApiRequest::Release {
                name: name.clone(),
                reason: None,
                expected_generation: Some(generation.to_string()),
                delete_identity: true,
                reply,
            }),
    )
    .await
    .expect("unacknowledged remote cleanup must not occupy the runtime actor");
    let ack = loop {
        if let FleetControlCommand::DeregisterAgent { reply, .. } =
            fixture.fleet_control_rx.recv().await.unwrap()
        {
            break reply;
        }
    };
    assert!(matches!(
        released.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    release.assert_hits(0);
    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::ActionInvoke(crate::fleet_wire::ActionInvoke {
                task_execution: None,
                v: FLEET_WIRE_VERSION,
                invocation_id: "replacement-attempt".into(),
                action: "spawn".into(),
                input: json!({"name":"retired", "cli":"claude"}),
                agent_name: Some("retired".into()),
                agent_id: None,
            }),
        ))
        .await;
    loop {
        if let FleetControlCommand::Send(BrokerToRelaycast::ActionResult(result)) =
            fixture.fleet_control_rx.recv().await.unwrap()
        {
            assert_eq!(result.invocation_id, "replacement-attempt");
            assert!(
                matches!(result.result, crate::fleet_wire::ActionResultPayload::Error(error) if error.error.contains("name_in_use"))
            );
            break;
        }
    }
    let mut replacement_spec = fixture.runtime.workers.workers["unrelated"].spec.clone();
    replacement_spec.name = name.clone();
    assert!(fixture
        .runtime
        .workers
        .spawn(
            replacement_spec,
            None,
            None,
            None,
            false,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("pending owned cleanup"));
    let (reply, listed) = oneshot::channel();
    tokio::time::timeout(
        Duration::from_millis(500),
        fixture
            .runtime
            .handle_api_request(ListenApiRequest::List { reply }),
    )
    .await
    .unwrap();
    assert!(
        listed.await.unwrap().is_ok(),
        "GET /api/spawned remains serviceable while ACK is withheld"
    );
    fixture.runtime.handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
        crate::fleet_wire::RelaycastToBroker::Deliver(Deliver {
            v: FLEET_WIRE_VERSION, agent: "unrelated".into(), agent_id: "unrelated-id".into(),
            delivery_id: "cleanup-parallel-delivery".into(), msg_id: "cleanup-parallel-message".into(), seq: 1,
            mode: DeliveryMode::Wait, payload: json!({"type":"message.created", "text":"independent delivery", "from":"sender", "channel":"general"}),
        })
    )).await;
    assert!(
        fixture
            .runtime
            .pending_deliveries
            .values()
            .any(|delivery| delivery.worker_name.as_str() == "unrelated"),
        "unrelated delivery must be admitted while cleanup waits"
    );
    ack.send(Err("fixture rejection".to_string())).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            fixture.runtime.reconcile_identity_cleanups().await;
            if let Ok(response) = released.try_recv() {
                break response;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cleanup completion should be reported");
    assert!(response.unwrap_err().contains("cleanup unconfirmed"));
    assert!(fixture
        .runtime
        .workers
        .owned_spawn_generations
        .contains_key(&name));
    assert!(fixture
        .runtime
        .fleet_delivery_book
        .active_agent_id(&name)
        .is_some());
    assert!(!fixture.runtime.fleet_inventory.contains_key(&name));
    release.assert_hits(0);

    // A later book update must never redirect retry teardown to another ID.
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(name.to_string(), "replacement-id".to_string());
    let (reply, mut retried) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: name.clone(),
            reason: None,
            expected_generation: Some(generation.to_string()),
            delete_identity: true,
            reply,
        })
        .await;
    let journal =
        std::fs::read_to_string(&cleanup_journal).expect("cleanup journal should persist");
    assert!(journal.contains(&generation.to_string()));
    assert!(journal.contains("bec092bff160b23541205064ab9f4485d6c2089760b1bb4e5f5ce19f0274aad3"));
    assert!(!journal.contains("owned-token"));
    fixture.runtime.reconcile_identity_cleanups().await;
    loop {
        if let FleetControlCommand::DeregisterAgent { request, reply } =
            fixture.fleet_control_rx.recv().await.unwrap()
        {
            assert_eq!(request.agent_id, "retired-id");
            reply.send(Ok(())).unwrap();
            break;
        }
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            fixture.runtime.reconcile_identity_cleanups().await;
            if let Ok(result) = retried.try_recv() {
                assert!(result.is_ok());
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    release.assert_hits(1);
    assert!(!fixture
        .runtime
        .workers
        .owned_spawn_generations
        .contains_key(&name));
    assert_eq!(
        fixture.runtime.fleet_delivery_book.active_agent_id(&name),
        Some("replacement-id")
    );
    assert!(fixture
        .runtime
        .workers
        .completed_owned_releases
        .contains(&(name, generation)));
    fixture.runtime.workers.shutdown_all().await.unwrap();
}

fn worker_event_runtime_fixture(
    workers: WorkerRegistry,
    pending_deliveries: HashMap<DeliveryId, PendingDelivery>,
) -> WorkerEventRuntimeFixture {
    worker_event_runtime_fixture_with_relay(workers, pending_deliveries, None)
}

fn worker_event_runtime_fixture_with_relay(
    workers: WorkerRegistry,
    pending_deliveries: HashMap<DeliveryId, PendingDelivery>,
    relay_base_url: Option<String>,
) -> WorkerEventRuntimeFixture {
    let temp_dir = tempfile::tempdir().expect("runtime fixture temp dir");
    let paths = RuntimePaths {
        persist: false,
        state: temp_dir.path().join("state.json"),
        pending: temp_dir.path().join("pending.json"),
        dead_letters: temp_dir.path().join("dead-letters.json"),
        dedup: temp_dir.path().join("dedup.json"),
        _lock: None,
    };
    let default_workspace =
        test_relay_workspace_with_base_url("ws_demo", Some("demo"), relay_base_url.as_deref());
    let default_workspace_id = Some(default_workspace.workspace_id.clone());
    let workspace_lookup = HashMap::from([(
        default_workspace.workspace_id.clone(),
        default_workspace.clone(),
    )]);
    let self_names = default_workspace.self_names.clone();
    let ws_control_tx = default_workspace.ws_control_tx.clone();
    let relaycast_http = default_workspace.http_client.clone();
    let (api_tx, api_rx) = mpsc::channel(4);
    let (_ws_inbound_tx, ws_inbound_rx) = mpsc::channel(4);
    let (fleet_control_tx, fleet_control_rx) = mpsc::channel(16);
    let (_fleet_event_tx, fleet_event_rx) = mpsc::channel(4);
    let (terminal_control_tx, _terminal_control_rx) = mpsc::channel(4);
    let (terminal_reconnect_tx, _terminal_reconnect_rx) = tokio::sync::watch::channel(None);
    let (_terminal_event_tx, terminal_event_rx) = mpsc::channel(4);
    let (sdk_out_tx, sdk_out_rx) = mpsc::channel(64);
    let (_worker_event_tx, worker_event_rx) = mpsc::channel(4);
    let (hosted_agent_event_tx, _hosted_agent_event_rx) = mpsc::channel(4);
    let mut reap_tick = tokio::time::interval(Duration::from_secs(60));
    reap_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut lease_check = tokio::time::interval(Duration::from_secs(60));
    lease_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    #[cfg(unix)]
    let sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install test SIGTERM listener");
    #[cfg(windows)]
    let sigterm =
        tokio::signal::windows::ctrl_shutdown().expect("install test Ctrl+Shutdown listener");

    let runtime = BrokerRuntime {
        degraded: None,
        persist: false,
        broker_start: Instant::now(),
        agent_spawn_count: 0,
        paths,
        state: crate::broker::BrokerState::default(),
        workspaces: vec![default_workspace.clone()],
        workspace_lookup,
        default_workspace,
        default_workspace_id,
        self_names,
        ws_control_tx,
        relaycast_http,
        hosted_agent_event_tx,
        pty_observability: HashMap::new(),
        api_rx,
        api_open: true,
        ws_inbound_rx,
        relaycast_open: true,
        fleet_control_tx,
        fleet_node_name: "test-node".to_string(),
        node_delivery_token_present: true,
        node_delivery_probe: std::sync::Arc::new(
            crate::node_delivery_probe::NodeDeliveryProbe::new(),
        ),
        node_delivery_connected: true,
        fleet_event_rx,
        fleet_control_open: true,
        terminal_control_tx,
        terminal_reconnect_tx,
        terminal_event_rx,
        terminal_control_open: true,
        terminal_sessions: HashMap::new(),
        terminal_snapshot_requests: HashMap::new(),
        terminal_input_requests: HashMap::new(),
        fleet_delivery_book: FleetDeliveryBook::default(),
        fleet_max_agents: 0,
        fleet_inventory: HashMap::new(),
        fleet_inventory_reconcile_retry_after: HashMap::new(),
        sdk_out_tx,
        worker_event_rx,
        worker_events_open: true,
        workers,
        crash_insights: crate::crash_insights::CrashInsights::default(),
        crash_insights_path: temp_dir.path().join("crash-insights.json"),
        sdk_lines: tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(tokio::io::stdin())),
        stdin_open: false,
        reap_tick,
        dedup: DedupCache::new(Duration::from_secs(60), 16),
        delivery_retry_interval: Duration::from_millis(10),
        pending_deliveries: PendingDeliveryStore::new(pending_deliveries),
        delivery_seam: crate::delivery::DeliverySeam::new(),
        dead_letters: DeadLetterStore::default(),
        terminal_failed_deliveries: super::event_loop::TerminalDeliveryGuard::default(),
        pending_requests: HashMap::new(),
        pending_verified_spawns: HashMap::new(),
        resize_owners: HashMap::new(),
        delivery_states: HashMap::new(),
        agent_result_tokens: HashMap::new(),
        task_provider: super::tasks::TaskProvider::default(),
        recent_thread_messages: std::collections::VecDeque::new(),
        shutdown: false,
        lease_duration: None,
        last_lease_renewal: Instant::now(),
        lease_check,
        sigterm,
        telemetry: TelemetryClient::default(),
        obligation_store: crate::obligation::ObligationStore::default(),
    };

    WorkerEventRuntimeFixture {
        runtime,
        api_tx,
        fleet_control_rx,
        _sdk_out_rx: sdk_out_rx,
        _temp_dir: temp_dir,
    }
}

fn delivery_lifecycle_worker_event(
    name: &str,
    generation: Uuid,
    event_type: &str,
    delivery_id: &str,
    event_id: &str,
) -> WorkerEvent {
    WorkerEvent::Message {
        name: WorkerName::from(name),
        generation,
        value: json!({
            "type": event_type,
            "payload": {
                "delivery_id": delivery_id,
                "event_id": event_id,
                "reason": "test terminal disposition",
            },
        }),
    }
}

fn inbound_ctx<'a>(event_id: &'a str) -> InboundContext<'a> {
    InboundContext {
        from: "Alice",
        body: "hello from relay",
        target: "#general",
        thread_id: Some("thr_123"),
        workspace_id: Some("ws_demo"),
        workspace_alias: Some("Demo"),
        priority: 1,
        mode: MessageInjectionMode::Steer,
        event_id: Some(event_id),
        relaycast_receipt: None,
    }
}

#[tokio::test]
async fn terminal_reconnect_control_frames_coalesce_without_blocking_node_control() {
    let (worker_event_tx, _worker_event_rx) = mpsc::channel(4);
    let workers = WorkerRegistry::new(
        worker_event_tx,
        Vec::new(),
        PathBuf::from("/tmp/terminal-reconnect-control-fixture"),
        Instant::now(),
    );
    let mut fixture = worker_event_runtime_fixture(workers, HashMap::new());
    let mut reconnect_rx = fixture.runtime.terminal_reconnect_tx.subscribe();

    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::TerminalReconnectRequested(
                crate::fleet_wire::TerminalReconnectRequested {
                    v: FLEET_WIRE_VERSION,
                    generation: 7,
                },
            ),
        ))
        .await;
    reconnect_rx.changed().await.unwrap();
    assert_eq!(*reconnect_rx.borrow_and_update(), Some(7));
    assert!(
        fixture.runtime.node_delivery_connected,
        "terminal recovery must not disturb the live node-control plane"
    );

    // The same generation is an attach-burst duplicate, not another dial
    // request. A newer cloud generation remains observable immediately.
    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::TerminalReconnectRequested(
                crate::fleet_wire::TerminalReconnectRequested {
                    v: FLEET_WIRE_VERSION,
                    generation: 7,
                },
            ),
        ))
        .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(25), reconnect_rx.changed())
            .await
            .is_err(),
        "duplicate generation woke a second dial attempt"
    );

    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::TerminalReconnectRequested(
                crate::fleet_wire::TerminalReconnectRequested {
                    v: FLEET_WIRE_VERSION,
                    generation: 8,
                },
            ),
        ))
        .await;
    reconnect_rx.changed().await.unwrap();
    assert_eq!(*reconnect_rx.borrow_and_update(), Some(8));
}

fn fleet_deliver(seq: u64) -> Deliver {
    Deliver {
        v: FLEET_WIRE_VERSION,
        agent: "worker-a".to_string(),
        agent_id: "agent-worker-a".to_string(),
        delivery_id: format!("delivery-{seq}"),
        msg_id: format!("message-{seq}"),
        seq,
        mode: DeliveryMode::Wait,
        payload: json!({"type": "message.created", "text": format!("message {seq}")}),
    }
}

fn held_fleet_message(deliver: &Deliver) -> PendingRelayMessage {
    PendingRelayMessage {
        from: "Alice".to_string(),
        body: format!("message {}", deliver.seq),
        target: MessageTarget::new("worker-a"),
        thread_id: None,
        workspace_id: Some(WorkspaceId::new("ws_demo")),
        workspace_alias: Some(WorkspaceAlias::new("Demo")),
        priority: 2,
        mode: MessageInjectionMode::Wait,
        queued_at_ms: super::unix_timestamp_millis(),
        event_id: Some(EventId::from(&deliver.msg_id)),
        relaycast_receipt: Some(RelaycastDeliveryReceipt {
            agent: WorkerName::from(&deliver.agent),
            agent_id: AgentId::from(&deliver.agent_id),
            delivery_id: DeliveryId::from(&deliver.delivery_id),
            msg_id: EventId::from(&deliver.msg_id),
            seq: deliver.seq,
        }),
    }
}

#[tokio::test]
async fn advancing_past_unobserved_siblings_accounts_for_every_removed_delivery() {
    let mut pending_deliveries = HashMap::new();
    for seq in 1..=3 {
        let delivery_id = format!("del_sibling_{seq}");
        let mut pending = make_pending_delivery(&delivery_id, "worker-a");
        pending.withheld_fleet_ack = Some(fleet_deliver(seq));
        pending_deliveries.insert(DeliveryId::new(delivery_id), pending);
    }
    let mut other = make_pending_delivery("del_other_agent", "worker-b");
    let mut other_ack = fleet_deliver(1);
    other_ack.agent = "worker-b".to_string();
    other_ack.agent_id = "agent-worker-b".to_string();
    other.withheld_fleet_ack = Some(other_ack);
    pending_deliveries.insert(DeliveryId::new("del_other_agent"), other);

    let mut terminal = super::event_loop::TerminalDeliveryGuard::default();
    let probe = crate::node_delivery_probe::NodeDeliveryProbe::new();
    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let mut dead_letters = DeadLetterStore::default();

    let dropped = dispose_pending_fleet_ack_prefix(
        &mut pending_deliveries,
        &mut terminal,
        &probe,
        &sdk_out_tx,
        &mut dead_letters,
        "agent-worker-a",
        2,
    )
    .await
    .expect("disposing an advanced prefix should be infallible");

    assert_eq!(dropped, 2, "both covered siblings must be accounted for");
    assert_eq!(pending_deliveries.len(), 2);
    assert!(pending_deliveries.contains_key("del_sibling_3"));
    assert!(pending_deliveries.contains_key("del_other_agent"));

    for delivery_id in ["del_sibling_1", "del_sibling_2"] {
        assert!(
            terminal.contains(delivery_id),
            "a late worker ack for {delivery_id} must not resurrect it"
        );
        let dead = dead_letters
            .get(delivery_id)
            .unwrap_or_else(|| panic!("{delivery_id} must remain operator-visible"));
        assert!(
            dead.reason
                .starts_with(crate::runtime::dead_letter::IN_DOUBT_REASON_PREFIX),
            "a purged possible write must not be auto-redeliverable: {}",
            dead.reason
        );
    }

    let mut failed_ids = Vec::new();
    let mut dead_ids = Vec::new();
    while let Ok(frame) = sdk_out_rx.try_recv() {
        match frame.payload.get("kind").and_then(Value::as_str) {
            Some("message_delivery_failed") => failed_ids.push(
                frame.payload["delivery_id"]
                    .as_str()
                    .expect("failure delivery id")
                    .to_string(),
            ),
            Some("dead_letter_added") => dead_ids.push(
                frame.payload["delivery_id"]
                    .as_str()
                    .expect("dead-letter delivery id")
                    .to_string(),
            ),
            _ => {}
        }
    }
    failed_ids.sort();
    dead_ids.sort();
    assert_eq!(failed_ids, ["del_sibling_1", "del_sibling_2"]);
    assert_eq!(dead_ids, failed_ids);
    assert_eq!(
        probe.snapshot_with_token(true)["dispositions"]["advanced_past_unobserved"],
        2,
        "each removed sibling needs its own observable disposition"
    );
}

fn pending_delivery(worker_name: &str, delivery_id: &str, event_id: &str) -> PendingDelivery {
    PendingDelivery {
        worker_name: WorkerName::from(worker_name),
        delivery: RelayDelivery {
            delivery_id: DeliveryId::new(delivery_id),
            event_id: EventId::new(event_id),
            workspace_id: Some(WorkspaceId::new("ws_test")),
            workspace_alias: Some(WorkspaceAlias::new("test")),
            from: "sender".to_string(),
            target: MessageTarget::new(worker_name),
            body: "hello".to_string(),
            thread_id: None,
            priority: None,
            injection_mode: MessageInjectionMode::Wait,
        },
        attempts: 1,
        failed_attempts: 0,
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: None,
        withheld_fleet_ack: None,
        withheld_fleet_ack_floor: None,
        sent_route: None,
    }
}

#[tokio::test]
async fn inbound_queue_auto_inject_drains_immediately_with_full_context() {
    let worker_name = "worker-a";
    let workers = make_worker_registry_with_worker(worker_name).await;
    let mut delivery_states = HashMap::new();

    let result = queue_inbound_for_delivery_mode(
        &mut delivery_states,
        &workers,
        worker_name,
        inbound_ctx("evt_auto"),
    );

    assert_eq!(result.evicted_from, None);
    match result.outcome {
        InboundQueueOutcome::DrainNow(messages) => {
            assert_eq!(messages.len(), 1);
            let msg = &messages[0];
            assert_eq!(msg.from, "Alice");
            assert_eq!(msg.body, "hello from relay");
            assert_eq!(msg.target, "#general");
            assert_eq!(msg.thread_id.as_deref(), Some("thr_123"));
            assert_eq!(msg.workspace_id.as_deref(), Some("ws_demo"));
            assert_eq!(msg.workspace_alias.as_deref(), Some("Demo"));
            assert_eq!(msg.priority, 1);
            assert_eq!(msg.mode, MessageInjectionMode::Steer);
            assert_eq!(msg.event_id.as_deref(), Some("evt_auto"));
        }
        other => panic!("expected immediate drain, got {other:?}"),
    }
    assert_eq!(
        delivery_states
            .get(worker_name)
            .expect("state should be created")
            .pending_snapshot(),
        Vec::new(),
        "auto_inject drains the per-worker pending queue in the same broker turn"
    );

    cleanup_worker_registry(workers).await;
}

#[tokio::test]
async fn inbound_queue_manual_flush_holds_until_explicit_drain() {
    let worker_name = "worker-a";
    let workers = make_worker_registry_with_worker(worker_name).await;
    let mut delivery_states = HashMap::from([(
        WorkerName::from(worker_name),
        InboundDeliveryState::new(InboundDeliveryMode::ManualFlush),
    )]);

    let result = queue_inbound_for_delivery_mode(
        &mut delivery_states,
        &workers,
        worker_name,
        inbound_ctx("evt_manual"),
    );

    assert_eq!(result.outcome, InboundQueueOutcome::Queued);
    assert_eq!(result.evicted_from, None);
    let snapshot = delivery_states
        .get(worker_name)
        .expect("manual state should remain present")
        .pending_snapshot();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].event_id.as_deref(), Some("evt_manual"));
    assert_eq!(snapshot[0].target, "#general");

    cleanup_worker_registry(workers).await;
}

#[tokio::test]
async fn worker_list_reports_pending_queue_depth() {
    let worker_name = "worker-a";
    let workers = make_worker_registry_with_worker(worker_name).await;
    let mut delivery_states = HashMap::from([(
        WorkerName::from(worker_name),
        InboundDeliveryState::new(InboundDeliveryMode::ManualFlush),
    )]);

    let mut pending_deliveries = HashMap::new();

    let counts = pending_message_counts(&delivery_states, &pending_deliveries);
    assert_eq!(workers.list(&counts)[0]["pending_messages"], 0);

    for event_id in ["evt_1", "evt_2"] {
        queue_inbound_for_delivery_mode(
            &mut delivery_states,
            &workers,
            worker_name,
            inbound_ctx(event_id),
        );
    }
    pending_deliveries.insert(
        DeliveryId::new("del_in_flight"),
        pending_delivery(worker_name, "del_in_flight", "evt_3"),
    );

    let counts = pending_message_counts(&delivery_states, &pending_deliveries);
    assert_eq!(
        workers.list(&counts)[0]["pending_messages"],
        3,
        "queued inbound messages plus in-flight deliveries are both still pending"
    );
    assert_eq!(
        workers.list(&HashMap::new())[0]["pending_messages"],
        0,
        "a worker with neither queue populated has nothing pending"
    );

    cleanup_worker_registry(workers).await;
}

#[tokio::test]
async fn inbound_queue_worker_missing_does_not_create_state() {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let workers = WorkerRegistry::new(
        tx,
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let mut delivery_states = HashMap::new();

    let result = queue_inbound_for_delivery_mode(
        &mut delivery_states,
        &workers,
        "ghost",
        inbound_ctx("evt_missing"),
    );

    assert_eq!(result.outcome, InboundQueueOutcome::WorkerMissing);
    assert_eq!(result.evicted_from, None);
    assert!(delivery_states.is_empty());
}

#[tokio::test]
async fn inbound_queue_rejects_overflow_without_evicting_held_message() {
    let worker_name = "worker-a";
    let workers = make_worker_registry_with_worker(worker_name).await;
    let mut delivery_states = HashMap::from([(
        WorkerName::from(worker_name),
        InboundDeliveryState::new(InboundDeliveryMode::ManualFlush),
    )]);

    for _ in 0..crate::types::MAX_PENDING_PER_WORKER {
        let result = queue_inbound_for_delivery_mode(
            &mut delivery_states,
            &workers,
            worker_name,
            inbound_ctx("evt_fill"),
        );
        assert_eq!(result.evicted_from, None);
    }

    let before = delivery_states
        .get(worker_name)
        .expect("state should exist")
        .pending_snapshot();
    let rejected_deliver = fleet_deliver(1);
    let mut rejected_ctx = inbound_ctx("message-1");
    rejected_ctx.relaycast_receipt = held_fleet_message(&rejected_deliver).relaycast_receipt;
    let result =
        queue_inbound_for_delivery_mode(&mut delivery_states, &workers, worker_name, rejected_ctx);

    assert_eq!(result.outcome, InboundQueueOutcome::RejectedFull);
    assert_eq!(result.evicted_from, None);
    assert_eq!(
        delivery_states
            .get(worker_name)
            .expect("state should exist")
            .pending_snapshot(),
        before,
        "a full queue must remain byte-for-byte unchanged"
    );
    let delivery_book = FleetDeliveryBook::default();
    assert_eq!(delivery_book.received_up_to_seq("agent-worker-a"), 0);
    assert_eq!(delivery_book.acked_up_to_seq("agent-worker-a"), 0);

    cleanup_worker_registry(workers).await;
}

#[tokio::test]
async fn manual_flush_injects_and_acks_multiple_sequences_in_fifo_order() {
    manual_flush_ack_diagnostics(false).await;
}

#[tokio::test]
async fn manual_flush_records_closed_control_ack_enqueue_failures() {
    manual_flush_ack_diagnostics(true).await;
}

async fn manual_flush_ack_diagnostics(closed: bool) {
    let worker_name = WorkerName::from("worker-a");
    let mut workers = make_worker_registry_with_worker(&worker_name).await;
    let first = fleet_deliver(1);
    let second = fleet_deliver(2);
    let first_message = held_fleet_message(&first);
    let second_message = held_fleet_message(&second);
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    state.accept_inbound(first_message);
    state.accept_inbound(second_message);
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);
    let mut delivery_book = FleetDeliveryBook::default();
    delivery_book.commit_received(&first);
    delivery_book.commit_received(&second);
    let (fleet_control_tx, mut fleet_control_rx) = mpsc::channel(4);

    if closed {
        fleet_control_rx.close();
    }
    let probe = crate::node_delivery_probe::NodeDeliveryProbe::new();

    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let _ = &mut sdk_out_rx;
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();
    let result = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &probe,
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_secs(1),
    )
    .await;

    let _ = &mut sdk_out_rx;
    assert_eq!(result.flushed, 2);
    assert_eq!(result.failure, None);
    assert!(delivery_states[&worker_name].pending.is_empty());
    assert_eq!(delivery_book.received_up_to_seq("agent-worker-a"), 2);
    assert_eq!(delivery_book.acked_up_to_seq("agent-worker-a"), 2);
    for expected_seq in if closed { vec![] } else { vec![1, 2] } {
        match fleet_control_rx.recv().await {
            Some(FleetControlCommand::Send(BrokerToRelaycast::DeliveryAck(ack))) => {
                assert_eq!(ack.agent, worker_name);
                assert_eq!(ack.up_to_seq, expected_seq);
            }
            other => panic!("expected delivery ACK {expected_seq}, got {other:?}"),
        }
    }
    assert!(fleet_control_rx.try_recv().is_err());

    let snapshot = probe.snapshot_with_token(true);
    assert_eq!(snapshot["acks"]["enqueued"], if closed { 0 } else { 2 });
    assert_eq!(
        snapshot["acks"]["enqueue_failed"],
        if closed { 2 } else { 0 }
    );
    assert_eq!(snapshot["acks"]["sent"], 0);
    cleanup_worker_registry(workers).await;
}

/// relay#1593 / #1559: a parked (`manual_flush`) queue must not be jammed
/// forever by a receipt whose Relaycast identity is no longer the live one.
///
/// The agent re-registers while messages sit parked — a spawn-time
/// `agent.register`, a token identity resolve, or an inventory repair all call
/// `bind_authoritative_identity`, which retires the previous `agent_id` and
/// drops its ACK cursor. The parked messages still carry receipts stamped with
/// the retired `agent_id`, so the ACK gate can never be satisfied for them
/// again. Before the fix the flush stopped at the head message and
/// returned `flushed: 0` for the rest of the worker's life: the agent went
/// permanently deaf while `send_dm` kept returning `recipientMatched: true`.
#[tokio::test]
async fn manual_flush_dead_letters_messages_whose_identity_was_rebound() {
    let worker_name = WorkerName::from("worker-a");
    let mut workers = make_worker_registry_with_worker(&worker_name).await;
    let first = fleet_deliver(1);
    let second = fleet_deliver(2);
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    state.accept_inbound(held_fleet_message(&first));
    state.accept_inbound(held_fleet_message(&second));
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);
    let mut delivery_book = FleetDeliveryBook::default();
    delivery_book.commit_received(&first);
    delivery_book.commit_received(&second);

    // The agent re-registers under a fresh Relaycast identity while its queue
    // is parked. This retires `agent-worker-a` and drops its cursor.
    assert_eq!(delivery_book.received_up_to_seq("agent-worker-a"), 2);
    delivery_book.bind_authoritative_identity("worker-a", "agent-worker-a-respawned");
    assert_eq!(
        delivery_book.received_up_to_seq("agent-worker-a"),
        0,
        "the retired identity's cursor must be gone — this is the precondition under test"
    );

    let (fleet_control_tx, mut fleet_control_rx) = mpsc::channel(4);
    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let _ = &mut sdk_out_rx;
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();
    let result = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &crate::node_delivery_probe::NodeDeliveryProbe::new(),
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_secs(1),
    )
    .await;

    assert_eq!(
        result.flushed, 0,
        "a retired identity's messages must not be injected into whoever holds the name now"
    );
    assert_eq!(
        result.dead_lettered, 2,
        "an orphaned receipt must not jam the parked queue — it is dead-lettered so the queue \
         drains and the agent hears everything that comes after"
    );
    assert_eq!(result.failure, None);
    assert!(
        delivery_states[&worker_name].pending.is_empty(),
        "the queue must be unjammed"
    );
    assert_eq!(dead_letters.len(), 2, "the orphans must be recoverable");
    assert!(
        dead_letters
            .iter()
            .all(|entry| entry.reason == "orphaned_delivery_receipt:identity_retired"),
        "the dead-letter reason must name why the receipt could not be delivered"
    );
    // The store alone is not the observable surface: a dashboard or SDK client
    // only learns about these through the event stream, so assert the frames.
    for expected_delivery_id in ["delivery-1", "delivery-2"] {
        let frame = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv())
            .await
            .expect("dead_letter_added should emit for every orphan")
            .expect("sdk_out_tx should remain open");
        assert_eq!(frame.payload["kind"], "dead_letter_added");
        assert_eq!(frame.payload["delivery_id"], expected_delivery_id);
        assert_eq!(
            frame.payload["reason"],
            "orphaned_delivery_receipt:identity_retired"
        );
    }
    // Nothing is ACKed: the receipts belong to a retired identity, so the
    // engine keeps ownership and its own redelivery policy is unchanged.
    assert!(
        fleet_control_rx.try_recv().is_err(),
        "a retired identity's receipt must never advance an ACK cursor"
    );

    cleanup_worker_registry(workers).await;
}

/// A full SDK event channel must not turn a maximum-size orphan flush into
/// `MAX_PENDING_PER_WORKER` consecutive timeout waits on the runtime loop.
#[tokio::test]
async fn manual_flush_dead_letter_events_do_not_serialize_backpressure_timeouts() {
    let worker_name = WorkerName::from("worker-a");
    let mut workers = make_worker_registry_with_worker(&worker_name).await;
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    let mut delivery_book = FleetDeliveryBook::default();
    for seq in 1..=crate::types::MAX_PENDING_PER_WORKER as u64 {
        let deliver = fleet_deliver(seq);
        state.accept_inbound(held_fleet_message(&deliver));
        delivery_book.commit_received(&deliver);
    }
    delivery_book.bind_authoritative_identity("worker-a", "agent-worker-a-respawned");
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);

    let (fleet_control_tx, _fleet_control_rx) = mpsc::channel(4);
    let (sdk_out_tx, _sdk_out_rx) = mpsc::channel(1);
    sdk_out_tx
        .try_send(ProtocolEnvelope {
            v: crate::protocol::PROTOCOL_VERSION,
            msg_type: "event".to_string(),
            request_id: None,
            payload: json!({ "kind": "channel_occupier" }),
        })
        .expect("the SDK channel should start full");
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();

    let result = tokio::time::timeout(
        Duration::from_millis(500),
        super::fleet::flush_pending_relay_messages(
            &mut delivery_states,
            &mut workers,
            &mut delivery_book,
            &fleet_control_tx,
            &crate::node_delivery_probe::NodeDeliveryProbe::new(),
            &sdk_out_tx,
            &mut dead_letters,
            &mut obligation_store,
            &worker_name,
            Duration::from_secs(1),
        ),
    )
    .await
    .expect("a full event channel must not add one timeout per dead letter");

    assert_eq!(
        result.dead_lettered,
        crate::types::MAX_PENDING_PER_WORKER,
        "event backpressure must not prevent the queue from draining"
    );
    assert!(delivery_states[&worker_name].pending.is_empty());
    assert_eq!(dead_letters.len(), crate::types::MAX_PENDING_PER_WORKER);

    cleanup_worker_registry(workers).await;
}

/// Same jam, reached without a re-registration: a node-control resume
/// handshake re-seeds the cursor at Relaycast's authoritative position
/// (`seed_cursor` sets `acked == received == up_to_seq`). Messages parked
/// below that position can never satisfy `seq == acked + 1` again.
#[tokio::test]
async fn manual_flush_dead_letters_messages_left_behind_by_a_reseeded_cursor() {
    let worker_name = WorkerName::from("worker-a");
    let mut workers = make_worker_registry_with_worker(&worker_name).await;
    let first = fleet_deliver(1);
    let second = fleet_deliver(2);
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    state.accept_inbound(held_fleet_message(&first));
    state.accept_inbound(held_fleet_message(&second));
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);
    let mut delivery_book = FleetDeliveryBook::default();
    delivery_book.commit_received(&first);
    delivery_book.commit_received(&second);

    // Reconnect: Relaycast reports it has already accounted for seq 2.
    delivery_book.bind_authoritative_identity("worker-a", "agent-worker-a");
    delivery_book.seed_cursor("worker-a", "agent-worker-a", 2);

    let (fleet_control_tx, mut fleet_control_rx) = mpsc::channel(4);
    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let _ = &mut sdk_out_rx;
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();
    let result = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &crate::node_delivery_probe::NodeDeliveryProbe::new(),
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_secs(1),
    )
    .await;

    assert_eq!(result.flushed, 0);
    assert_eq!(
        result.dead_lettered, 2,
        "already-accounted receipts must clear the queue, not hold it forever"
    );
    assert_eq!(result.failure, None);
    assert!(delivery_states[&worker_name].pending.is_empty());
    assert_eq!(dead_letters.len(), 2, "the orphans must be recoverable");
    assert!(
        dead_letters
            .iter()
            .all(|entry| entry.reason == "orphaned_delivery_receipt:cursor_moved_past"),
        "a re-seeded cursor must be distinguishable from a retired identity"
    );
    for expected_delivery_id in ["delivery-1", "delivery-2"] {
        let frame = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv())
            .await
            .expect("dead_letter_added should emit for every orphan")
            .expect("sdk_out_tx should remain open");
        assert_eq!(frame.payload["kind"], "dead_letter_added");
        assert_eq!(frame.payload["delivery_id"], expected_delivery_id);
        assert_eq!(
            frame.payload["reason"],
            "orphaned_delivery_receipt:cursor_moved_past"
        );
    }
    assert_eq!(delivery_book.acked_up_to_seq("agent-worker-a"), 2);
    assert!(
        fleet_control_rx.try_recv().is_err(),
        "no ACK regression below the seeded cursor"
    );

    cleanup_worker_registry(workers).await;
}

/// cubic review finding on PR #1639: a boomerang obligation outlives the queue
/// entry it was registered for. Dead-lettering an orphaned parked message
/// without cancelling its obligation leaves maintenance firing up to three
/// boomerang reminders at a recipient about a message that never reached them.
#[tokio::test]
async fn manual_flush_cancels_the_obligation_of_a_dead_lettered_parked_message() {
    let worker_name = WorkerName::from("worker-a");
    let mut workers = make_worker_registry_with_worker(&worker_name).await;
    let first = fleet_deliver(1);
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    state.accept_inbound(held_fleet_message(&first));
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);
    let mut delivery_book = FleetDeliveryBook::default();
    delivery_book.commit_received(&first);
    delivery_book.bind_authoritative_identity("worker-a", "agent-worker-a-respawned");

    let mut obligation_store = crate::obligation::ObligationStore::default();
    obligation_store.register(
        "message-1".to_string(),
        "Alice".to_string(),
        worker_name.to_string(),
        Duration::from_millis(1),
    );
    // Pre-condition: without the cancel this obligation is due and would fire.
    assert_eq!(
        obligation_store
            .drain_due(
                Instant::now() + Duration::from_secs(1),
                Duration::from_millis(1),
                |_| true,
            )
            .len(),
        1,
        "the obligation must be live before the flush"
    );
    obligation_store = crate::obligation::ObligationStore::default();
    obligation_store.register(
        "message-1".to_string(),
        "Alice".to_string(),
        worker_name.to_string(),
        Duration::from_millis(1),
    );

    let (fleet_control_tx, _fleet_control_rx) = mpsc::channel(4);
    let (sdk_out_tx, _sdk_out_rx) = mpsc::channel(16);
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let result = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &crate::node_delivery_probe::NodeDeliveryProbe::new(),
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_secs(1),
    )
    .await;

    assert_eq!(result.dead_lettered, 1);
    assert!(
        obligation_store
            .drain_due(
                Instant::now() + Duration::from_secs(1),
                Duration::from_millis(1),
                |_| true,
            )
            .is_empty(),
        "a dead-lettered message must not keep boomeranging at its recipient"
    );

    cleanup_worker_registry(workers).await;
}

/// cubic review finding on PR #1639: an `agent_id` can move to a *different
/// name* while the old name still holds a parked queue. `bind_identity` carries
/// the cursor across and rewrites `cursor.agent_name`, so a lookup by
/// `agent_id` alone still finds a live cursor and would classify the stale
/// receipt `Ready`. Committing it makes `commit_acked_receipt` rewrite
/// `cursor.agent_name` back to the old name and ACK against it, after which
/// `observe` rejects every delivery for the identity's current name as an
/// identity conflict — corrupting a healthy agent to unjam a stale one.
#[tokio::test]
async fn manual_flush_orphans_a_receipt_whose_identity_now_answers_to_another_name() {
    let worker_name = WorkerName::from("worker-a");
    let mut workers = make_worker_registry_with_worker(&worker_name).await;
    let first = fleet_deliver(1);
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    state.accept_inbound(held_fleet_message(&first));
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);
    let mut delivery_book = FleetDeliveryBook::default();
    delivery_book.commit_received(&first);

    // The identity keeps its agent_id but is rebound to a different name.
    delivery_book.bind_authoritative_identity("worker-b", "agent-worker-a");

    let (fleet_control_tx, mut fleet_control_rx) = mpsc::channel(4);
    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let _ = &mut sdk_out_rx;
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();
    let result = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &crate::node_delivery_probe::NodeDeliveryProbe::new(),
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_secs(1),
    )
    .await;

    assert_eq!(result.flushed, 0);
    assert_eq!(result.dead_lettered, 1);
    assert!(
        fleet_control_rx.try_recv().is_err(),
        "a receipt for a superseded name binding must never emit an ACK"
    );
    assert_eq!(
        delivery_book.active_agent_id("worker-b"),
        Some("agent-worker-a"),
        "the live name binding must survive the stale queue's flush"
    );

    cleanup_worker_registry(workers).await;
}

/// The guard that must survive the fix: a genuine ordering gap (seq 2 parked
/// while seq 1 is still outstanding) still stops the flush, so held frames are
/// never ACKed out of order.
#[tokio::test]
async fn manual_flush_still_stops_on_a_genuine_sequence_gap() {
    let worker_name = WorkerName::from("worker-a");
    let mut workers = make_worker_registry_with_worker(&worker_name).await;
    let first = fleet_deliver(1);
    let second = fleet_deliver(2);
    let expected = vec![held_fleet_message(&second)];
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    // Reuse the exact expected message: `held_fleet_message` stamps
    // `queued_at_ms` with the current millisecond, so building it twice can
    // differ across a tick boundary and flake the snapshot comparison.
    state.accept_inbound(expected[0].clone());
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);
    let mut delivery_book = FleetDeliveryBook::default();
    // Both were received, but seq 1 is still unACKed on the auto-inject path,
    // so seq 2 is not yet `acked + 1`.
    delivery_book.commit_received(&first);
    delivery_book.commit_received(&second);

    let (fleet_control_tx, mut fleet_control_rx) = mpsc::channel(4);
    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let _ = &mut sdk_out_rx;
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();
    let result = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &crate::node_delivery_probe::NodeDeliveryProbe::new(),
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_secs(1),
    )
    .await;

    assert_eq!(result.flushed, 0);
    assert!(
        result.failure.is_some(),
        "an out-of-order receipt must still hold the queue"
    );
    assert_eq!(result.blocked_reason_code, Some("missing_predecessor_ack"));
    assert_eq!(result.head_sequence, Some(2));
    assert_eq!(result.acked_up_to_sequence, Some(0));
    assert_eq!(result.received_up_to_sequence, Some(2));
    assert_eq!(result.next_ackable_sequence, Some(1));
    assert_eq!(delivery_states[&worker_name].pending_snapshot(), expected);
    assert_eq!(delivery_book.acked_up_to_seq("agent-worker-a"), 0);
    assert!(fleet_control_rx.try_recv().is_err());

    cleanup_worker_registry(workers).await;
}

/// A flush should actively replay a durable in-flight predecessor instead of
/// merely reporting that every parked successor is blocked. The replay keeps
/// both custody records intact until the worker confirms, then the same queue
/// drains normally on the next flush.
#[tokio::test]
async fn manual_flush_replays_a_durable_predecessor_then_drains_without_loss() {
    let worker_name = WorkerName::from("worker-a");
    let mut workers = make_worker_registry_with_worker(&worker_name).await;
    let first = fleet_deliver(1);
    let second = fleet_deliver(2);
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    state.accept_inbound(held_fleet_message(&second));
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);
    let mut delivery_book = FleetDeliveryBook::default();
    delivery_book.commit_received(&first);
    delivery_book.commit_received(&second);

    let mut first_pending = pending_delivery(
        worker_name.as_str(),
        first.delivery_id.as_str(),
        first.msg_id.as_str(),
    );
    first_pending.withheld_fleet_ack = Some(first.clone());
    first_pending.withheld_fleet_ack_floor = Some(first.seq);
    let mut pending_deliveries =
        HashMap::from([(DeliveryId::from(&first.delivery_id), first_pending)]);
    let (fleet_control_tx, mut fleet_control_rx) = mpsc::channel(4);
    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let _ = &mut sdk_out_rx;
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();
    let probe = crate::node_delivery_probe::NodeDeliveryProbe::new();

    let blocked = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &probe,
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_secs(1),
    )
    .await;
    assert_eq!(blocked.next_ackable_sequence, Some(first.seq));

    let action = super::fleet::reconcile_blocked_flush_predecessor(
        &blocked,
        &mut workers,
        &mut pending_deliveries,
        &sdk_out_tx,
        &mut dead_letters,
        &worker_name,
        Duration::from_secs(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await;
    assert_eq!(action, Some("predecessor_replayed"));
    assert_eq!(
        pending_deliveries[&DeliveryId::from(&first.delivery_id)].attempts,
        2,
        "reconciliation must add exactly one replay attempt to the existing handoff"
    );
    assert_eq!(delivery_states[&worker_name].pending_len(), 1);
    assert!(dead_letters.is_empty());

    let (_, resolved) = super::fleet::confirm_pending_delivery_and_resolve_fleet_ack(
        &mut pending_deliveries,
        first.delivery_id.as_str(),
        Some(first.msg_id.as_str()),
        worker_name.as_str(),
        "delivery_ack",
        &mut delivery_book,
    );
    assert_eq!(resolved, Some((first.agent.clone(), first.seq)));
    assert!(pending_deliveries.is_empty());

    let drained = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &probe,
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_secs(1),
    )
    .await;
    assert_eq!(drained.flushed, 1);
    assert_eq!(drained.failure, None);
    assert!(delivery_states[&worker_name].pending.is_empty());
    match fleet_control_rx.recv().await {
        Some(FleetControlCommand::Send(BrokerToRelaycast::DeliveryAck(ack))) => {
            assert_eq!(ack.up_to_seq, second.seq);
        }
        other => panic!("expected successor ACK after reconciliation, got {other:?}"),
    }

    cleanup_worker_registry(workers).await;
}

/// relay#1837: if broker custody of an already-received predecessor vanished,
/// Relaycast's exact replay must rebuild that custody ahead of later parked
/// sequences. A further replay while custody exists must not queue or inject a
/// second copy. Once restored, one flush delivers the complete contiguous
/// prefix and advances ACKs without loss.
#[tokio::test]
async fn manual_flush_reconciles_an_unacknowledged_replay_without_loss_or_duplication() {
    let worker_name = WorkerName::from("worker-a");
    let workers = make_worker_registry_with_worker(&worker_name).await;
    let mut fixture = worker_event_runtime_fixture(workers, HashMap::new());
    let missing = fleet_deliver(89);
    let successor = fleet_deliver(90);

    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(&missing.agent, &missing.agent_id);
    fixture.runtime.fleet_delivery_book.seed_cursor(
        &missing.agent,
        &missing.agent_id,
        missing.seq - 1,
    );
    // Both frames reached the broker, but local custody for 89 disappeared
    // before its ACK. Only 90 remains in the manual queue.
    fixture
        .runtime
        .fleet_delivery_book
        .commit_received(&missing);
    fixture
        .runtime
        .fleet_delivery_book
        .commit_received(&successor);
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    state.accept_inbound(held_fleet_message(&successor));
    fixture
        .runtime
        .delivery_states
        .insert(worker_name.clone(), state);

    let conflicting = crate::fleet_wire::Deliver {
        delivery_id: "different-delivery-89".to_string(),
        ..missing.clone()
    };
    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::Deliver(conflicting),
        ))
        .await;
    assert_eq!(
        fixture.runtime.delivery_states[&worker_name].pending_len(),
        1,
        "same message/sequence under a different delivery ID must not be resurfaced"
    );
    assert!(
        fixture.fleet_control_rx.try_recv().is_err(),
        "a conflicting delivery identity must fail closed without ACK"
    );

    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::Deliver(missing.clone()),
        ))
        .await;
    let sequences = fixture.runtime.delivery_states[&worker_name]
        .pending_snapshot()
        .into_iter()
        .map(|message| message.relaycast_receipt.unwrap().seq)
        .collect::<Vec<_>>();
    assert_eq!(
        sequences,
        vec![89, 90],
        "the replayed predecessor must be restored before its successor"
    );

    let conflicting_with_custody = crate::fleet_wire::Deliver {
        delivery_id: "yet-another-delivery-89".to_string(),
        ..missing.clone()
    };
    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::Deliver(conflicting_with_custody),
        ))
        .await;
    assert_eq!(
        fixture.runtime.delivery_states[&worker_name].pending_len(),
        2,
        "a conflicting delivery identity must also fail closed while exact custody exists"
    );
    assert!(
        fixture.fleet_control_rx.try_recv().is_err(),
        "the conflicting identity must remain unACKed while exact custody exists"
    );

    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::Deliver(missing.clone()),
        ))
        .await;
    assert_eq!(
        fixture.runtime.delivery_states[&worker_name].pending_len(),
        2,
        "a replay with live queue custody must not create a duplicate"
    );
    match fixture.fleet_control_rx.recv().await {
        Some(FleetControlCommand::Send(BrokerToRelaycast::DeliveryAck(ack))) => {
            assert_eq!(
                ack.up_to_seq, 88,
                "custody replay may only restate the safe floor"
            );
        }
        other => panic!("expected safe-floor ACK for the custody replay, got {other:?}"),
    }

    let result = super::fleet::flush_pending_relay_messages(
        &mut fixture.runtime.delivery_states,
        &mut fixture.runtime.workers,
        &mut fixture.runtime.fleet_delivery_book,
        &fixture.runtime.fleet_control_tx,
        &fixture.runtime.node_delivery_probe,
        &fixture.runtime.sdk_out_tx,
        &mut fixture.runtime.dead_letters,
        &mut fixture.runtime.obligation_store,
        &worker_name,
        fixture.runtime.delivery_retry_interval,
    )
    .await;

    assert_eq!(result.flushed, 2);
    assert_eq!(result.failure, None);
    assert!(fixture.runtime.delivery_states[&worker_name]
        .pending_snapshot()
        .is_empty());
    assert_eq!(
        fixture
            .runtime
            .fleet_delivery_book
            .acked_up_to_seq(&missing.agent_id),
        successor.seq
    );
    for expected_seq in [89, 90] {
        match fixture.fleet_control_rx.recv().await {
            Some(FleetControlCommand::Send(BrokerToRelaycast::DeliveryAck(ack))) => {
                assert_eq!(ack.up_to_seq, expected_seq);
            }
            other => panic!("expected delivery ACK {expected_seq}, got {other:?}"),
        }
    }

    cleanup_worker_registry(fixture.runtime.workers).await;
}

/// A blocked queue at its normal admission cap must still have one bounded
/// recovery slot for the exact predecessor that makes its head drainable.
/// Rejecting that replay would make capacity impossible to free without
/// dropping an unACKed successor.
#[tokio::test]
async fn manual_flush_full_queue_admits_predecessor_without_losing_a_successor() {
    let worker_name = WorkerName::from("worker-a");
    let workers = make_worker_registry_with_worker(&worker_name).await;
    let mut fixture = worker_event_runtime_fixture(workers, HashMap::new());
    let missing = fleet_deliver(89);

    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(&missing.agent, &missing.agent_id);
    fixture.runtime.fleet_delivery_book.seed_cursor(
        &missing.agent,
        &missing.agent_id,
        missing.seq - 1,
    );
    fixture
        .runtime
        .fleet_delivery_book
        .commit_received(&missing);

    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    let last_sequence = missing.seq + crate::types::MAX_PENDING_PER_WORKER as u64;
    for sequence in (missing.seq + 1)..=last_sequence {
        let successor = fleet_deliver(sequence);
        fixture
            .runtime
            .fleet_delivery_book
            .commit_received(&successor);
        state.accept_inbound(held_fleet_message(&successor));
    }
    assert_eq!(state.pending_len(), crate::types::MAX_PENDING_PER_WORKER);
    fixture
        .runtime
        .delivery_states
        .insert(worker_name.clone(), state);

    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::Deliver(missing.clone()),
        ))
        .await;

    let sequences = fixture.runtime.delivery_states[&worker_name]
        .pending_snapshot()
        .into_iter()
        .map(|message| message.relaycast_receipt.unwrap().seq)
        .collect::<Vec<_>>();
    assert_eq!(
        sequences.len(),
        crate::types::MAX_PENDING_PER_WORKER + 1,
        "only the bounded recovery slot may exceed the normal queue cap"
    );
    assert_eq!(sequences.first(), Some(&missing.seq));
    assert_eq!(sequences.last(), Some(&last_sequence));
    assert_eq!(
        sequences,
        (missing.seq..=last_sequence).collect::<Vec<_>>(),
        "every parked successor must remain in order without loss"
    );

    cleanup_worker_registry(fixture.runtime.workers).await;
}

#[tokio::test]
async fn manual_flush_failure_retains_failed_message_and_suffix_without_ack() {
    let worker_name = WorkerName::from("worker-a");
    let (worker_event_tx, _worker_event_rx) = mpsc::channel::<WorkerEvent>(4);
    let mut workers = WorkerRegistry::new(
        worker_event_tx,
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let first = fleet_deliver(1);
    let second = fleet_deliver(2);
    let expected = vec![held_fleet_message(&first), held_fleet_message(&second)];
    let mut state = InboundDeliveryState::new(InboundDeliveryMode::ManualFlush);
    for message in expected.iter().cloned() {
        state.accept_inbound(message);
    }
    let mut delivery_states = HashMap::from([(worker_name.clone(), state)]);
    let mut delivery_book = FleetDeliveryBook::default();
    delivery_book.commit_received(&first);
    delivery_book.commit_received(&second);
    let (fleet_control_tx, mut fleet_control_rx) = mpsc::channel(4);

    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let _ = &mut sdk_out_rx;
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();
    let result = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
        &crate::node_delivery_probe::NodeDeliveryProbe::new(),
        &sdk_out_tx,
        &mut dead_letters,
        &mut obligation_store,
        &worker_name,
        Duration::from_millis(50),
    )
    .await;

    assert_eq!(result.flushed, 0);
    assert!(result.failure.is_some());
    assert_eq!(delivery_states[&worker_name].pending_snapshot(), expected);
    assert_eq!(delivery_book.received_up_to_seq("agent-worker-a"), 2);
    assert_eq!(delivery_book.acked_up_to_seq("agent-worker-a"), 0);
    assert!(fleet_control_rx.try_recv().is_err());
}

fn make_pending_delivery(delivery_id: &str, worker: &str) -> PendingDelivery {
    PendingDelivery {
        worker_name: WorkerName::from(worker),
        delivery: RelayDelivery {
            delivery_id: DeliveryId::new(delivery_id),
            event_id: EventId::new(format!("evt_{delivery_id}")),
            workspace_id: Some(WorkspaceId::new("ws_demo")),
            workspace_alias: None,
            from: "Lead".to_string(),
            target: MessageTarget::new("Worker"),
            body: "hello".to_string(),
            thread_id: None,
            priority: Some(2),
            injection_mode: MessageInjectionMode::Wait,
        },
        attempts: 1,
        failed_attempts: 0,
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: None,
        withheld_fleet_ack: None,
        withheld_fleet_ack_floor: None,
        sent_route: None,
    }
}

#[test]
fn shutdown_persists_nonempty_pending_deliveries() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("pending-deliveries.json");
    let mut delivery = make_pending_delivery("del_keep", "worker-a");
    delivery.failed_attempts = 2;
    let deliveries = HashMap::from([(DeliveryId::new("del_keep"), delivery)]);

    persist_pending_on_shutdown(&path, true, &deliveries);

    let reloaded = load_pending_deliveries(&path);
    assert_eq!(reloaded.len(), 1, "pending delivery survives shutdown");
    let pending = reloaded
        .get("del_keep")
        .expect("persisted delivery should reload by id");
    assert_eq!(pending.worker_name, WorkerName::from("worker-a"));
    assert_eq!(pending.delivery.event_id, EventId::new("evt_del_keep"));
    assert_eq!(pending.attempts, 1);
    assert_eq!(pending.failed_attempts, 2);
}

#[test]
fn pending_delivery_load_defaults_legacy_failure_count() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("pending-deliveries.json");
    let delivery = make_pending_delivery("del_legacy", "worker-a");
    let deliveries = HashMap::from([(DeliveryId::new("del_legacy"), delivery)]);
    super::save_pending_deliveries(&path, &deliveries).expect("pending delivery should save");
    let mut json: Value = serde_json::from_slice(
        &std::fs::read(&path).expect("pending delivery snapshot should read"),
    )
    .expect("pending delivery snapshot should parse");
    json[0]
        .as_object_mut()
        .expect("pending delivery entry should be an object")
        .remove("failed_attempts");
    std::fs::write(
        &path,
        serde_json::to_vec(&json).expect("legacy snapshot encodes"),
    )
    .expect("legacy pending snapshot should write");

    let loaded = load_pending_deliveries(&path);
    assert_eq!(loaded["del_legacy"].failed_attempts, 0);
}

// relay#1543 delivery.rs:190 MUST-FIRE (P1, blocker): a withheld fleet
// (engine-facing) ack must survive a broker restart along with the delivery
// it belongs to. Before this fix, `load_pending_deliveries` unconditionally
// reset `withheld_fleet_ack` to `None` on every reload — so a delivery that
// was persisted mid-flight (worker handed the injection but hadn't confirmed
// yet) came back after restart with its ack silently dropped. The retried
// delivery could still reach the worker and get echo-confirmed, but
// `resolve_pending_fleet_ack` would then have nothing to release: the engine
// stays unacknowledged and may redeliver a message the worker already has.
// This simulates a real restart end-to-end — shutdown persist, then startup
// load — rather than asserting on the intermediate `PersistedPendingDelivery`
// struct, so it catches a regression anywhere in that round trip.
#[test]
fn withheld_fleet_ack_survives_a_simulated_restart() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("pending-deliveries.json");
    let mut delivery = make_pending_delivery("del_inflight", "worker-a");
    delivery.withheld_fleet_ack = Some(withheld_ack_for("del_inflight"));
    delivery.withheld_fleet_ack_floor = Some(1);
    let deliveries = HashMap::from([(DeliveryId::new("del_inflight"), delivery)]);

    // Shutdown: persist whatever is still pending, exactly as the broker
    // does before exiting.
    persist_pending_on_shutdown(&path, true, &deliveries);

    // Startup: reload from disk, exactly as the broker does on the next boot.
    let reloaded = load_pending_deliveries(&path);
    let pending = reloaded
        .get("del_inflight")
        .expect("the in-flight delivery must survive the restart");
    assert_eq!(
        pending
            .withheld_fleet_ack
            .as_ref()
            .map(|d| d.msg_id.as_str()),
        Some("evt_del_inflight"),
        "the withheld fleet ack must survive the restart along with the delivery it belongs \
         to — otherwise a retried delivery that goes on to land has no ack left to release, \
         and the engine stays permanently unacknowledged for it"
    );
    assert_eq!(pending.withheld_fleet_ack_floor, Some(1));
}

// relay#1543 delivery.rs:190 companion: a snapshot written by a broker
// version that predates `withheld_fleet_ack` (or a fresh delivery that never
// had one) must still load cleanly with the field defaulted to `None`,
// mirroring `pending_delivery_load_defaults_legacy_failure_count` above for
// `failed_attempts`. This is the other half of the P1 fix — `#[serde(default)]`
// must actually work, not just be present in the struct definition.
#[test]
fn legacy_pending_delivery_snapshot_without_withheld_ack_field_loads_as_none() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("pending-deliveries.json");
    let delivery = make_pending_delivery("del_legacy_ack", "worker-a");
    let deliveries = HashMap::from([(DeliveryId::new("del_legacy_ack"), delivery)]);
    super::save_pending_deliveries(&path, &deliveries).expect("pending delivery should save");
    let mut json: Value = serde_json::from_slice(
        &std::fs::read(&path).expect("pending delivery snapshot should read"),
    )
    .expect("pending delivery snapshot should parse");
    json[0]
        .as_object_mut()
        .expect("pending delivery entry should be an object")
        .remove("withheld_fleet_ack");
    json[0]
        .as_object_mut()
        .expect("pending delivery entry should be an object")
        .remove("withheld_fleet_ack_floor");
    std::fs::write(
        &path,
        serde_json::to_vec(&json).expect("legacy snapshot encodes"),
    )
    .expect("legacy pending snapshot should write");

    let loaded = load_pending_deliveries(&path);
    assert_eq!(
        loaded["del_legacy_ack"].withheld_fleet_ack, None,
        "a pre-relay#1543 snapshot has no withheld_fleet_ack field at all — it must load as \
         None (the same state that delivery actually had), not fail to deserialize"
    );
    assert_eq!(loaded["del_legacy_ack"].withheld_fleet_ack_floor, None);
}

#[test]
fn shutdown_removes_pending_file_only_when_empty() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("pending-deliveries.json");
    std::fs::write(&path, "[]").expect("seed file should write");
    let deliveries: HashMap<DeliveryId, PendingDelivery> = HashMap::new();

    persist_pending_on_shutdown(&path, true, &deliveries);

    assert!(
        !path.exists(),
        "clean shutdown with nothing pending removes the file"
    );
}

#[test]
fn shutdown_without_persist_writes_nothing() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("pending-deliveries.json");
    let deliveries = HashMap::from([(
        DeliveryId::new("del_lost"),
        make_pending_delivery("del_lost", "worker-a"),
    )]);

    persist_pending_on_shutdown(&path, false, &deliveries);

    assert!(
        !path.exists(),
        "persistence disabled — shutdown must not write state files"
    );
}

#[test]
fn pending_delivery_store_tracks_mutations() {
    let mut store = PendingDeliveryStore::new(HashMap::new());
    assert!(!store.take_dirty(), "fresh store starts clean");

    // Read-only access goes through `Deref` and stays clean.
    assert!(store.is_empty());
    assert!(!store.take_dirty());

    store.insert(
        DeliveryId::new("del_1"),
        make_pending_delivery("del_1", "worker-a"),
    );
    assert!(store.take_dirty(), "insert marks the store dirty");
    assert!(!store.take_dirty(), "take_dirty clears the flag");

    // `&mut HashMap` coercion — the path used by the free delivery
    // helpers — must also mark the store dirty.
    let map: &mut HashMap<DeliveryId, PendingDelivery> = &mut store;
    map.remove("del_1");
    assert!(store.take_dirty(), "mutation via DerefMut marks dirty");
}

fn make_dead_letter(delivery_id: &str, worker: &str, reason: &str) -> DeadLetterEntry {
    DeadLetterEntry::from_pending(&make_pending_delivery(delivery_id, worker), reason)
}

#[test]
fn dead_letter_store_caps_size_and_evicts_oldest() {
    let mut store = DeadLetterStore::default();
    for index in 0..MAX_DEAD_LETTERS {
        assert!(
            store
                .push(make_dead_letter(&format!("del_{index}"), "worker-a", "x"))
                .is_none(),
            "no eviction below the cap"
        );
    }
    assert_eq!(store.len(), MAX_DEAD_LETTERS);

    let evicted = store
        .push(make_dead_letter("del_overflow", "worker-a", "x"))
        .expect("push past the cap evicts the oldest entry");
    assert_eq!(evicted.delivery.delivery_id, DeliveryId::new("del_0"));
    assert_eq!(store.len(), MAX_DEAD_LETTERS, "store stays at the cap");
    assert!(store.get("del_0").is_none(), "oldest entry is gone");
    assert!(store.get("del_overflow").is_some(), "newest entry is kept");
}

#[test]
fn dead_letter_store_trims_oversized_load_and_marks_dirty() {
    // A snapshot larger than the cap (older version, manual edit, or a bug)
    // must be bounded on load, keeping the newest MAX_DEAD_LETTERS entries.
    let oversized: Vec<DeadLetterEntry> = (0..MAX_DEAD_LETTERS + 5)
        .map(|index| make_dead_letter(&format!("del_{index}"), "worker-a", "x"))
        .collect();
    let mut store = DeadLetterStore::new(oversized);

    assert_eq!(
        store.len(),
        MAX_DEAD_LETTERS,
        "oversized load is trimmed to cap"
    );
    assert!(
        store.get("del_0").is_none(),
        "oldest over-cap entries are dropped"
    );
    assert!(
        store
            .get(&format!("del_{}", MAX_DEAD_LETTERS + 4))
            .is_some(),
        "newest entries are kept"
    );
    assert!(
        store.take_dirty(),
        "trimming an oversized load marks the store dirty so the next flush rewrites the capped file"
    );

    // A within-cap load must not spuriously mark the store dirty.
    let mut small = DeadLetterStore::new(vec![make_dead_letter("del_a", "worker-a", "x")]);
    assert!(!small.take_dirty(), "a within-cap load stays clean");
}

#[test]
fn dead_letter_store_tracks_mutations() {
    let mut store = DeadLetterStore::default();
    assert!(!store.take_dirty(), "fresh store starts clean");

    store.push(make_dead_letter("del_1", "worker-a", "recipient gone"));
    assert!(store.take_dirty(), "push marks the store dirty");
    assert!(!store.take_dirty(), "take_dirty clears the flag");

    assert!(store.get("del_1").is_some());
    assert!(!store.take_dirty(), "reads stay clean");

    assert!(store.remove("del_missing").is_none());
    assert!(
        !store.take_dirty(),
        "removing a missing id is not a mutation"
    );

    assert!(store.remove("del_1").is_some());
    assert!(store.take_dirty(), "remove marks the store dirty");
}

#[test]
fn redeliver_requeues_dead_letter_and_resets_retries() {
    let mut dead_letters = DeadLetterStore::default();
    let mut pending_deliveries: HashMap<DeliveryId, PendingDelivery> = HashMap::new();
    let mut source = make_pending_delivery("del_retry", "worker-a");
    source.attempts = MAX_DELIVERY_RETRIES;
    source.last_error = Some("max delivery retries exceeded".to_string());
    dead_letters.push(DeadLetterEntry::from_pending(
        &source,
        "max delivery retries exceeded",
    ));

    let requeued = requeue_dead_letter(&mut dead_letters, &mut pending_deliveries, "del_retry")
        .expect("dead letter should requeue by id");

    assert!(dead_letters.is_empty(), "requeued entry leaves the DLQ");
    assert_eq!(requeued.attempts, 0, "retry count resets on redeliver");
    assert_eq!(requeued.last_error, None, "stale error clears on redeliver");
    assert_ne!(
        requeued.delivery.delivery_id.as_str(),
        "del_retry",
        "redeliver mints a fresh delivery id so late acks from the exhausted attempt cannot match"
    );
    assert_eq!(
        requeued.delivery.event_id, source.delivery.event_id,
        "event id (message identity) is preserved across redeliver"
    );
    let pending = pending_deliveries
        .get(requeued.delivery.delivery_id.as_str())
        .expect("requeued delivery joins the pending map under its new id");
    assert_eq!(pending.delivery.body, source.delivery.body);
    assert_eq!(pending.worker_name, source.worker_name);
    assert_eq!(
        pending.queued_at_ms, source.queued_at_ms,
        "original queue time is preserved for age reporting"
    );

    assert!(
        requeue_dead_letter(&mut dead_letters, &mut pending_deliveries, "del_retry").is_none(),
        "redelivering an unknown id is a no-op"
    );
}

#[test]
fn redeliver_survives_a_stale_ack_from_the_previous_attempt() {
    // A delivery exhausts its retries and is dead-lettered, then redelivered.
    let mut dead_letters = DeadLetterStore::default();
    let mut pending_deliveries: HashMap<DeliveryId, PendingDelivery> = HashMap::new();
    let mut source = make_pending_delivery("del_stale", "worker-a");
    source.attempts = MAX_DELIVERY_RETRIES;
    let stale_event_id = source.delivery.event_id.as_str().to_string();
    dead_letters.push(DeadLetterEntry::from_pending(
        &source,
        "max delivery retries exceeded",
    ));

    let requeued = requeue_dead_letter(&mut dead_letters, &mut pending_deliveries, "del_stale")
        .expect("dead letter should requeue by id");
    let new_id = requeued.delivery.delivery_id.as_str().to_string();

    // A late ACK from the exhausted attempt arrives carrying the ORIGINAL
    // delivery id (and its event id). It must not clear the redelivered entry.
    let cleared = clear_pending_delivery_if_event_matches(
        &mut pending_deliveries,
        "del_stale",
        Some(&stale_event_id),
        "worker-a",
        "delivery_ack",
    );
    assert!(
        cleared.is_none(),
        "a stale ack for the old id matches nothing"
    );
    assert!(
        pending_deliveries.contains_key(new_id.as_str()),
        "the redelivered entry survives the stale ack from the previous attempt"
    );

    // The genuine ack for the redelivered attempt (new id) clears it normally.
    let cleared = clear_pending_delivery_if_event_matches(
        &mut pending_deliveries,
        &new_id,
        Some(&stale_event_id),
        "worker-a",
        "delivery_ack",
    );
    assert!(
        cleared.is_some(),
        "the current attempt's ack clears the entry"
    );
    assert!(pending_deliveries.is_empty());
}

// `is_worker_live` only probes child liveness on Unix (`kill(pid, 0)`); the
// `cfg(not(unix))` implementation always returns `true`, so the stopped-child
// assertion below is Unix-specific.
#[cfg(unix)]
#[tokio::test]
async fn is_worker_live_gates_redeliver_skip_on_child_liveness() {
    // The redeliver handler skips entries whose recipient is not running by
    // probing `is_worker_live` (not mere registration), so a dead-but-present
    // worker is reported "recipient not running" instead of being requeued and
    // immediately bounced back to the DLQ.
    let mut workers = make_worker_registry_with_worker("worker-a").await;
    assert!(
        workers.is_worker_live("worker-a"),
        "a running child is live"
    );
    assert!(
        !workers.is_worker_live("ghost"),
        "an unregistered recipient is not live"
    );

    // Kill the child but leave it in the registry (the reap sweep hasn't run).
    if let Some(handle) = workers.workers.get_mut("worker-a") {
        let _ = handle.child.start_kill();
        let _ = handle.child.wait().await;
    }
    assert!(
        !workers.is_worker_live("worker-a"),
        "a stopped child is not live, so redeliver leaves the entry in the DLQ"
    );
    assert!(
        workers.has_worker("worker-a"),
        "has_worker still reports the stopped child as present — the gap is_worker_live closes"
    );
}

#[test]
fn dead_letters_round_trip_persistence() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("dead-letters.json");
    let mut store = DeadLetterStore::default();
    store.push(make_dead_letter("del_a", "worker-a", "recipient gone"));
    store.push(make_dead_letter("del_b", "worker-b", "worker_exited"));

    save_dead_letters(&path, &store).expect("dead letters should save");

    let reloaded = DeadLetterStore::new(load_dead_letters(&path));
    assert_eq!(reloaded.len(), 2);
    let entry = reloaded.get("del_a").expect("entry reloads by id");
    assert_eq!(entry.worker_name, WorkerName::from("worker-a"));
    assert_eq!(entry.reason, "recipient gone");
    assert_eq!(entry.delivery.event_id, EventId::new("evt_del_a"));
    assert!(entry.failed_at_ms > 0, "failure timestamp survives reload");
}

#[test]
fn shutdown_persists_dead_letters_and_removes_empty_file() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("dead-letters.json");

    let mut store = DeadLetterStore::default();
    store.push(make_dead_letter("del_keep", "worker-a", "worker_exited"));
    persist_dead_letters_on_shutdown(&path, true, &store);
    assert_eq!(
        DeadLetterStore::new(load_dead_letters(&path)).len(),
        1,
        "dead letters survive shutdown"
    );

    persist_dead_letters_on_shutdown(&path, true, &DeadLetterStore::default());
    assert!(!path.exists(), "empty store removes the file");

    let mut store = DeadLetterStore::default();
    store.push(make_dead_letter("del_lost", "worker-a", "worker_exited"));
    persist_dead_letters_on_shutdown(&path, false, &store);
    assert!(!path.exists(), "persistence disabled writes nothing");
}

#[tokio::test]
async fn retry_exhaustion_dead_letters_instead_of_discarding() {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let mut workers = WorkerRegistry::new(
        tx,
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let mut exhausted = make_pending_delivery("del_exhausted", "ghost");
    exhausted.attempts = MAX_DELIVERY_RETRIES;
    exhausted.failed_attempts = MAX_DELIVERY_RETRIES;
    exhausted.last_error = Some("failed writing frame".to_string());
    let mut pending_deliveries =
        HashMap::from([(DeliveryId::new("del_exhausted"), exhausted.clone())]);

    let outcome = retry_pending_delivery(
        &DeliveryId::new("del_exhausted"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("exhausted retries should classify as terminal failure");

    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(4);
    let mut dead_letters = DeadLetterStore::default();
    emit_delivery_attempt_outcome(
        &sdk_out_tx,
        &mut dead_letters,
        &DeliveryId::new("del_exhausted"),
        true,
        outcome,
    )
    .await
    .expect("terminal outcome should emit");

    assert!(
        pending_deliveries.is_empty(),
        "entry leaves the pending map"
    );
    let entry = dead_letters
        .get("del_exhausted")
        .expect("exhausted delivery is retained in the dead-letter store");
    assert_eq!(entry.attempts, MAX_DELIVERY_RETRIES);
    assert_eq!(entry.reason, "failed writing frame");
    assert_eq!(entry.delivery.body, exhausted.delivery.body);

    let failed_frame = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv())
        .await
        .expect("message_delivery_failed should emit")
        .expect("sdk_out_tx should remain open");
    assert_eq!(failed_frame.payload["kind"], "message_delivery_failed");
    let dead_frame = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv())
        .await
        .expect("dead_letter_added should emit")
        .expect("sdk_out_tx should remain open");
    assert_eq!(dead_frame.payload["kind"], "dead_letter_added");
    assert_eq!(dead_frame.payload["delivery_id"], "del_exhausted");
    assert_eq!(dead_frame.payload["reason"], "failed writing frame");
}

fn withheld_ack_for(delivery_id: &str) -> Deliver {
    Deliver {
        v: FLEET_WIRE_VERSION,
        agent: "agent-a".to_string(),
        agent_id: "agent-a-id".to_string(),
        delivery_id: delivery_id.to_string(),
        msg_id: format!("evt_{delivery_id}"),
        seq: 1,
        mode: DeliveryMode::Wait,
        payload: json!({}),
    }
}

// relay#1543 delivery.rs:588 MUST-FIRE (P1, blocker): when the initial
// worker handoff outlives `retry_interval`, the withheld fleet ack must
// already be registered on the `PendingDelivery` — not dependent on the
// timed-out call's `Ok(DeliveryId)` ever reaching the caller. Before the
// fix, `try_inject_pending_relay_message` returned only a bare `Result`
// derived from the timed-out future, and the fleet caller registered the
// withheld ack as a *separate* follow-up step keyed off that return value;
// a handoff that timed out returned `Err`, so the ack was simply never
// registered even though the delivery itself remained alive and retryable —
// a later successful retry's echo would then have had nothing to resolve.
#[tokio::test]
async fn timed_out_initial_handoff_still_registers_its_withheld_fleet_ack() {
    let mut registry = make_worker_registry_with_stalled_worker("worker-a").await;
    let deliver = fleet_deliver(1);
    let msg = held_fleet_message(&deliver);
    let mut pending_deliveries = HashMap::new();
    let mut seam = crate::delivery::DeliverySeam::new();
    let queue_capacity_before = registry.workers["worker-a"].command_tx.capacity();

    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        try_inject_pending_relay_message(
            &mut registry,
            &mut pending_deliveries,
            "worker-a",
            &msg,
            Duration::from_millis(20),
            Some(deliver.clone()),
            Some(deliver.seq),
            &mut seam,
        ),
    )
    .await
    .expect(
        "the test's own generous bound must never fire — only the short \
         retry_interval passed to try_inject_pending_relay_message should",
    );

    assert!(
        outcome.is_err(),
        "a handoff that never completes must time out, not hang forever"
    );
    let error = outcome.expect_err("checked above");
    assert!(
        error
            .downcast_ref::<crate::runtime::delivery::TerminalInDoubtError>()
            .is_some(),
        "a deadline after writer-queue admission must be typed in-doubt, got {error:?}"
    );
    assert_eq!(
        pending_deliveries.len(),
        1,
        "the delivery must remain registered and retryable even though the initial handoff timed out"
    );
    let registered = pending_deliveries
        .values()
        .next()
        .expect("checked len() == 1 above");
    assert_eq!(
        registered
            .withheld_fleet_ack
            .as_ref()
            .map(|d| d.msg_id.as_str()),
        Some(deliver.msg_id.as_str()),
        "the withheld fleet ack must be registered before the timeout can expire, so a later \
         successful retry can still resolve it"
    );
    assert_eq!(
        registered.failed_attempts, MAX_DELIVERY_RETRIES,
        "the deadline must make the pending entry terminal before a maintenance tick can retry it"
    );
    assert_eq!(
        registry.workers["worker-a"].command_tx.capacity(),
        queue_capacity_before - 1,
        "the first handoff must have crossed the writer-queue commit boundary"
    );

    let delivery_id = registered.delivery.delivery_id.clone();
    let terminal = retry_pending_delivery(
        &delivery_id,
        &mut registry,
        &mut pending_deliveries,
        Duration::from_millis(20),
        &mut seam,
    )
    .await
    .expect("terminal in-doubt settlement is an outcome, not a transport error");
    assert!(
        matches!(terminal, DeliveryAttemptOutcome::TerminalInDoubt { .. }),
        "the next tick must settle without writing again, got {terminal:?}"
    );
    assert_eq!(
        registry.workers["worker-a"].command_tx.capacity(),
        queue_capacity_before - 1,
        "settling the cancelled handoff must not enqueue a second PTY frame"
    );

    cleanup_worker_registry(registry).await;
}

// relay#1543 helper-level companion (parameterised over every terminal
// disposition): a
// `PendingDelivery`'s withheld fleet ack must never survive the delivery it
// belongs to. Before the structural fix, `pending_fleet_acks` was a second
// map that none of these dispositions — except one very manually-threaded
// retry-exhaustion call site — knew to clean up. The ack now lives on
// `PendingDelivery` itself, so every path that disposes of the delivery
// disposes of the ack with it, by construction.
#[tokio::test]
async fn terminal_disposition_helpers_remove_withheld_fleet_ack_state() {
    // Disposition 1: retry-exhaustion dead-letter (delivery.rs:816's thread)
    // — the `emit_delivery_attempt_outcome` `Failed` arm.
    {
        let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
        let mut workers = WorkerRegistry::new(
            tx,
            Vec::new(),
            PathBuf::from("/tmp/agent-relay-broker-tests"),
            Instant::now(),
        );
        let mut exhausted = make_pending_delivery("del_exhausted_ack", "ghost");
        exhausted.attempts = MAX_DELIVERY_RETRIES;
        exhausted.failed_attempts = MAX_DELIVERY_RETRIES;
        exhausted.withheld_fleet_ack = Some(withheld_ack_for("del_exhausted_ack"));
        let mut pending_deliveries =
            HashMap::from([(DeliveryId::new("del_exhausted_ack"), exhausted)]);

        let outcome = retry_pending_delivery(
            &DeliveryId::new("del_exhausted_ack"),
            &mut workers,
            &mut pending_deliveries,
            Duration::from_millis(1),
            &mut crate::delivery::DeliverySeam::new(),
        )
        .await
        .expect("exhausted retries should classify as terminal failure");
        match &outcome {
            DeliveryAttemptOutcome::Failed { pending, .. } => assert!(
                pending.withheld_fleet_ack.is_some(),
                "fixture must carry a withheld ack for this case to be meaningful"
            ),
            other => panic!("expected terminal failure, got {other:?}"),
        }

        let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(4);
        let mut dead_letters = DeadLetterStore::default();
        emit_delivery_attempt_outcome(
            &sdk_out_tx,
            &mut dead_letters,
            &DeliveryId::new("del_exhausted_ack"),
            true,
            outcome,
        )
        .await
        .expect("terminal outcome should emit");

        assert!(!pending_deliveries.contains_key("del_exhausted_ack"));
        let mut book = FleetDeliveryBook::default();
        assert_eq!(
            super::fleet::resolve_pending_fleet_ack(
                pending_deliveries.get("del_exhausted_ack"),
                &mut book
            ),
            None,
            "a retry-exhausted delivery must never resolve into an engine ack"
        );
        let _ = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv()).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv()).await;
    }

    // Dispositions 2 & 3: worker-exit and `delivery_failed` both dispose of a
    // `PendingDelivery` via `emit_dropped_delivery_failures` — the single
    // choke point every worker-teardown path (`take_pending_for_worker`,
    // maintenance.rs:26 / event_loop.rs:255's threads) and the
    // `delivery_failed` worker-event path share. This is driven through a
    // real `pending_deliveries` map (via `take_pending_for_worker`, the same
    // removal every one of those call sites uses) so the final assertion
    // observes state the code under test actually produced, mirroring
    // dispositions 1 and 4 below — not a hardcoded `None` that would pass
    // for any implementation. See relay#1543 tests.rs:1142's review thread.
    for reason in ["worker_exited", "delivery_failed"] {
        let mut pending = make_pending_delivery("del_dropped_ack", "ghost");
        pending.withheld_fleet_ack = Some(withheld_ack_for("del_dropped_ack"));
        let mut pending_deliveries = HashMap::from([(DeliveryId::new("del_dropped_ack"), pending)]);

        let dropped = take_pending_for_worker(&mut pending_deliveries, "ghost");
        assert_eq!(
            dropped.len(),
            1,
            "fixture must carry exactly the one delivery being torn down for {reason}"
        );

        let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(4);
        let mut dead_letters = DeadLetterStore::default();
        emit_dropped_delivery_failures(&sdk_out_tx, &mut dead_letters, &dropped, reason)
            .await
            .expect("dropped delivery outcome should emit");

        let mut book = FleetDeliveryBook::default();
        assert_eq!(
            super::fleet::resolve_pending_fleet_ack(
                pending_deliveries.get("del_dropped_ack"),
                &mut book
            ),
            None,
            "a delivery dropped for {reason} must never resolve into an engine ack"
        );
        let _ = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv()).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv()).await;
    }

    // Disposition 4: a `WorkerMissing` fleet injection whose recipient never
    // existed (fleet.rs:741's thread) — before the fix this injected via a
    // bare `workers.deliver` call outside `pending_deliveries`, so nothing
    // ever tracked its withheld ack at all. Routed through
    // `insert_and_attempt_delivery` like `DrainNow`, it is tracked from the
    // first attempt and reaches the exact same terminal cleanup as every
    // other disposition above.
    {
        let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
        let mut workers = WorkerRegistry::new(
            tx,
            Vec::new(),
            PathBuf::from("/tmp/agent-relay-broker-tests"),
            Instant::now(),
        ); // no worker ever registered
        let relay_delivery = RelayDelivery {
            delivery_id: DeliveryId::new("del_worker_missing"),
            event_id: EventId::new("evt_worker_missing"),
            workspace_id: None,
            workspace_alias: None,
            from: "Alice".to_string(),
            target: MessageTarget::new("ghost"),
            body: "hello".to_string(),
            thread_id: None,
            priority: Some(2),
            injection_mode: MessageInjectionMode::Wait,
        };
        let mut pending_deliveries = HashMap::new();

        let first_attempt = super::insert_and_attempt_delivery(
            &mut workers,
            &mut pending_deliveries,
            "ghost",
            relay_delivery,
            Duration::from_millis(1),
            Some(withheld_ack_for("del_worker_missing")),
            Some(1),
            &mut crate::delivery::DeliverySeam::new(),
        )
        .await;
        assert!(
            first_attempt.is_err(),
            "a missing recipient must fail the handoff"
        );
        let tracked = pending_deliveries.get("del_worker_missing").expect(
            "the delivery must remain tracked for the terminal-failure path to dead-letter it, \
             not vanish silently",
        );
        assert!(
            tracked.withheld_fleet_ack.is_some(),
            "the withheld ack must have survived the failed first attempt"
        );

        // The next retry attempt (e.g. the maintenance sweep) observes the
        // same missing recipient and reaches the terminal `Failed` outcome
        // that `emit_delivery_attempt_outcome` dead-letters and drops the
        // ack for — same as every other disposition in this test.
        let outcome = retry_pending_delivery(
            &DeliveryId::new("del_worker_missing"),
            &mut workers,
            &mut pending_deliveries,
            Duration::from_millis(1),
            &mut crate::delivery::DeliverySeam::new(),
        )
        .await
        .expect("a still-missing recipient should classify as terminal failure");

        let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(4);
        let mut dead_letters = DeadLetterStore::default();
        emit_delivery_attempt_outcome(
            &sdk_out_tx,
            &mut dead_letters,
            &DeliveryId::new("del_worker_missing"),
            true,
            outcome,
        )
        .await
        .expect("terminal outcome should emit");

        assert!(!pending_deliveries.contains_key("del_worker_missing"));
        let mut book = FleetDeliveryBook::default();
        assert_eq!(
            super::fleet::resolve_pending_fleet_ack(
                pending_deliveries.get("del_worker_missing"),
                &mut book
            ),
            None,
            "a delivery to a permanently missing worker must never resolve into an engine ack"
        );
        let _ = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv()).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv()).await;
    }
}

// Full runtime/channel companion for the terminal-disposition coverage above.
// Each real disposal path removes the pending delivery first; a late matching
/// relay#1680 review (P2, codex + cubic). The deferred (echo-confirmed) ACK
/// advances `acked_up_to_seq` long after the deliver frame was handled. While
/// the cursor snapshot was published only from `handle_fleet_deliver`, that
/// advance was invisible: `GET /api/node-delivery` kept serving the old ACK
/// until some later frame happened to arrive. Publication now runs off the
/// book's dirty flag once per event-loop turn, so the confirmation surfaces.
/// relay#1680 review (coderabbitai, fleet.rs:857) MUST-FIRE.
///
/// `acked_without_surfacing` is stamped before the ack is handed to the
/// node-control task. When that task is gone the ack goes nowhere and the
/// engine will redeliver, but the disposition still reads as an acknowledgement
/// — the instrument reporting a success that did not happen. The `acks`
/// tallies are what separate the two, and they are only worth anything if the
/// runtime actually stops swallowing the channel error.
#[tokio::test]
async fn an_ack_that_never_left_the_runtime_is_reported_as_such() {
    let worker_name = "agent-a";
    let registry = make_worker_registry_with_worker(worker_name).await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());

    let deliver = withheld_ack_for("del_ack_enqueue_failed");
    // Seed the book so the frame below is a duplicate: that plans a bare
    // `Acknowledge`, which is the shortest path to the ack send.
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(deliver.agent.clone(), deliver.agent_id.clone());
    fixture
        .runtime
        .fleet_delivery_book
        .commit_delivered(&deliver);

    // The node-control task is gone; nothing can receive the ack.
    drop(fixture.fleet_control_rx);

    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::Deliver(deliver.clone()),
        ))
        .await;

    let snapshot = fixture
        .runtime
        .node_delivery_probe
        .snapshot_with_token(true);
    assert_eq!(
        snapshot["dispositions"]["acked_without_surfacing"], 1,
        "the runtime did decide to acknowledge this frame"
    );
    assert_eq!(
        snapshot["acks"]["enqueue_failed"], 1,
        "the ack never reached the node-control task, and the endpoint must \
         say so rather than leave the disposition reading as a delivered ack"
    );
    assert_eq!(
        snapshot["acks"]["enqueued"], 0,
        "nothing was handed off, so nothing may be tallied as enqueued"
    );
    assert_eq!(snapshot["acks"]["sent"], 0);
}

#[tokio::test]
async fn a_worker_confirmed_ack_becomes_visible_on_the_node_delivery_endpoint() {
    let worker_name = "worker-a";
    let registry = make_worker_registry_with_worker(worker_name).await;
    let generation = registry.workers[worker_name].generation;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());

    let delivery_id = DeliveryId::new("del_runtime_cursor_publish");
    let deliver = Deliver {
        agent: worker_name.to_string(),
        agent_id: "worker-a-id".to_string(),
        delivery_id: delivery_id.to_string(),
        msg_id: format!("evt_{delivery_id}"),
        ..withheld_ack_for(delivery_id.as_str())
    };

    // The state right after an injection: received, ack withheld pending echo.
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(deliver.agent.clone(), deliver.agent_id.clone());
    fixture
        .runtime
        .fleet_delivery_book
        .commit_received(&deliver);
    fixture.runtime.publish_fleet_delivery_cursors_if_dirty();

    let acked_of = |probe: &crate::node_delivery_probe::NodeDeliveryProbe| {
        probe.snapshot_with_token(true)["cursors"][0]["acked_up_to_seq"].clone()
    };
    assert_eq!(
        acked_of(&fixture.runtime.node_delivery_probe),
        serde_json::json!(0),
        "the ack is withheld until the worker confirms"
    );

    let mut pending = make_pending_delivery(delivery_id.as_str(), worker_name);
    pending.withheld_fleet_ack = Some(deliver.clone());
    fixture
        .runtime
        .pending_deliveries
        .insert(delivery_id.clone(), pending);

    // The worker echoes the injection back: the deferred ACK is released.
    fixture
        .runtime
        .handle_worker_event(delivery_lifecycle_worker_event(
            worker_name,
            generation,
            "delivery_ack",
            delivery_id.as_str(),
            format!("evt_{}", delivery_id.as_str()).as_str(),
        ))
        .await;

    // One event-loop turn's post-processing, as `run()` performs it.
    fixture.runtime.publish_fleet_delivery_cursors_if_dirty();
    assert_eq!(
        acked_of(&fixture.runtime.node_delivery_probe),
        serde_json::json!(1),
        "a worker-confirmed delivery must advance the published ACK cursor, \
         not leave the endpoint serving the pre-confirmation value"
    );
}

// worker `delivery_ack` is then driven through `BrokerRuntime::handle_worker_event`.
// None may produce a fleet-control Send, even though the event reaches the same
// branch that releases a successful withheld ACK.
#[tokio::test]
async fn every_terminal_disposition_drops_its_withheld_fleet_ack() {
    let worker_name = "worker-a";
    let registry = make_worker_registry_with_worker(worker_name).await;
    let generation = registry.workers[worker_name].generation;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());

    // Retry exhaustion.
    let exhausted_id = DeliveryId::new("del_runtime_exhausted");
    let mut exhausted = make_pending_delivery(exhausted_id.as_str(), worker_name);
    exhausted.attempts = MAX_DELIVERY_RETRIES;
    exhausted.failed_attempts = MAX_DELIVERY_RETRIES;
    exhausted.withheld_fleet_ack = Some(withheld_ack_for(exhausted_id.as_str()));
    fixture
        .runtime
        .pending_deliveries
        .insert(exhausted_id.clone(), exhausted);
    let exhausted_outcome = retry_pending_delivery(
        &exhausted_id,
        &mut fixture.runtime.workers,
        &mut fixture.runtime.pending_deliveries,
        Duration::from_millis(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("retry exhaustion should classify as terminal");
    emit_delivery_attempt_outcome(
        &fixture.runtime.sdk_out_tx,
        &mut fixture.runtime.dead_letters,
        &exhausted_id,
        true,
        exhausted_outcome,
    )
    .await
    .expect("retry exhaustion should be emitted");
    fixture
        .runtime
        .handle_worker_event(delivery_lifecycle_worker_event(
            worker_name,
            generation,
            "delivery_ack",
            exhausted_id.as_str(),
            format!("evt_{}", exhausted_id.as_str()).as_str(),
        ))
        .await;
    assert!(
        fixture.fleet_control_rx.try_recv().is_err(),
        "retry exhaustion must not release a withheld fleet ack"
    );

    // Worker teardown (`take_pending_for_worker` is the shared release/reap
    // choke point).
    let exited_id = DeliveryId::new("del_runtime_worker_exited");
    let mut exited = make_pending_delivery(exited_id.as_str(), worker_name);
    exited.withheld_fleet_ack = Some(withheld_ack_for(exited_id.as_str()));
    fixture
        .runtime
        .pending_deliveries
        .insert(exited_id.clone(), exited);
    let dropped = take_pending_for_worker(&mut fixture.runtime.pending_deliveries, worker_name);
    emit_dropped_delivery_failures(
        &fixture.runtime.sdk_out_tx,
        &mut fixture.runtime.dead_letters,
        &dropped,
        "worker_exited",
    )
    .await
    .expect("worker teardown should be emitted");
    fixture
        .runtime
        .handle_worker_event(delivery_lifecycle_worker_event(
            worker_name,
            generation,
            "delivery_ack",
            exited_id.as_str(),
            format!("evt_{}", exited_id.as_str()).as_str(),
        ))
        .await;
    assert!(
        fixture.fleet_control_rx.try_recv().is_err(),
        "worker teardown must not release a withheld fleet ack"
    );

    // Worker-reported terminal injection failure, driven wholly through the
    // runtime handler for both the failure and the late confirmation.
    let failed_id = DeliveryId::new("del_runtime_delivery_failed");
    let mut failed = make_pending_delivery(failed_id.as_str(), worker_name);
    failed.withheld_fleet_ack = Some(withheld_ack_for(failed_id.as_str()));
    fixture
        .runtime
        .pending_deliveries
        .insert(failed_id.clone(), failed);
    let failed_event_id = format!("evt_{}", failed_id.as_str());
    fixture
        .runtime
        .handle_worker_event(delivery_lifecycle_worker_event(
            worker_name,
            generation,
            "delivery_failed",
            failed_id.as_str(),
            &failed_event_id,
        ))
        .await;
    fixture
        .runtime
        .handle_worker_event(delivery_lifecycle_worker_event(
            worker_name,
            generation,
            "delivery_ack",
            failed_id.as_str(),
            &failed_event_id,
        ))
        .await;
    assert!(
        fixture.fleet_control_rx.try_recv().is_err(),
        "delivery_failed must not release a withheld fleet ack"
    );

    // Permanently missing worker. Register a same-name replacement only after
    // the real WorkerMissing path dead-letters the delivery, so the late event
    // is current and reaches the runtime ACK branch instead of being discarded
    // by the stale-generation guard.
    let missing_id = DeliveryId::new("del_runtime_worker_missing");
    let relay_delivery = RelayDelivery {
        delivery_id: missing_id.clone(),
        event_id: EventId::new(format!("evt_{}", missing_id.as_str())),
        workspace_id: None,
        workspace_alias: None,
        from: "Alice".to_string(),
        target: MessageTarget::new("ghost"),
        body: "hello".to_string(),
        thread_id: None,
        priority: Some(2),
        injection_mode: MessageInjectionMode::Wait,
    };
    let first_attempt = super::insert_and_attempt_delivery(
        &mut fixture.runtime.workers,
        &mut fixture.runtime.pending_deliveries,
        "ghost",
        relay_delivery,
        Duration::from_millis(1),
        Some(withheld_ack_for(missing_id.as_str())),
        Some(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await;
    assert!(first_attempt.is_err());
    let missing_outcome = retry_pending_delivery(
        &missing_id,
        &mut fixture.runtime.workers,
        &mut fixture.runtime.pending_deliveries,
        Duration::from_millis(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("missing worker retry should classify as terminal");
    emit_delivery_attempt_outcome(
        &fixture.runtime.sdk_out_tx,
        &mut fixture.runtime.dead_letters,
        &missing_id,
        true,
        missing_outcome,
    )
    .await
    .expect("missing worker failure should be emitted");

    let mut replacement_registry = make_worker_registry_with_worker("ghost").await;
    let replacement = replacement_registry
        .workers
        .remove("ghost")
        .expect("replacement worker handle");
    let replacement_generation = replacement.generation;
    fixture
        .runtime
        .workers
        .workers
        .insert(WorkerName::from("ghost"), replacement);
    fixture
        .runtime
        .handle_worker_event(delivery_lifecycle_worker_event(
            "ghost",
            replacement_generation,
            "delivery_ack",
            missing_id.as_str(),
            format!("evt_{}", missing_id.as_str()).as_str(),
        ))
        .await;
    assert!(
        fixture.fleet_control_rx.try_recv().is_err(),
        "WorkerMissing must not release a withheld fleet ack"
    );

    cleanup_worker_registry(fixture.runtime.workers).await;
}

/// Seam rule 4 (docs/native-delivery-migration.md): "Never claim an
/// acknowledgement you did not observe."
///
/// `delivery_verified { verification: "timeout_fallback" }` is what the PTY
/// worker reports when the injection write was handed over and the echo never
/// came back. That is a hand-off in doubt, not a delivery, so it must produce
/// none of the engine-facing consequences of an observed ack: no
/// `message_delivery_confirmed` and no read ack. And because seam rule 2
/// forbids re-sending on doubt, it must not be left pending either —
/// `runtime/maintenance.rs` would re-inject it.
///
/// Two controls keep the negative assertions from passing for the wrong
/// reason: the echo arm proves the same event shape still confirms, and the
/// late-ack arm proves the fallback settled the delivery terminally rather
/// than merely being ignored by the handler.
#[tokio::test]
async fn timeout_fallback_never_confirms_or_acks_an_unobserved_delivery() {
    struct Observed {
        kinds: Vec<String>,
        fleet_ack_released: bool,
        still_pending: bool,
        terminal: bool,
    }

    async fn drive_verification(verification: &str, then_late_ack: bool) -> Observed {
        let worker_name = "worker-a";
        let registry = make_worker_registry_with_worker(worker_name).await;
        let generation = registry.workers[worker_name].generation;
        let delivery_id = DeliveryId::new("del_timeout_fallback");
        let event_id = format!("evt_{}", delivery_id.as_str());
        let mut pending = make_pending_delivery(delivery_id.as_str(), worker_name);
        pending.withheld_fleet_ack = Some(withheld_ack_for(delivery_id.as_str()));
        let mut fixture =
            worker_event_runtime_fixture(registry, HashMap::from([(delivery_id.clone(), pending)]));

        fixture
            .runtime
            .handle_worker_event(WorkerEvent::Message {
                name: WorkerName::from(worker_name),
                generation,
                value: json!({
                    "type": "delivery_verified",
                    "payload": {
                        "delivery_id": delivery_id.as_str(),
                        "event_id": event_id,
                        "verification": verification,
                        "reason": "echo not detected within 5s window",
                    },
                }),
            })
            .await;

        if then_late_ack {
            fixture
                .runtime
                .handle_worker_event(delivery_lifecycle_worker_event(
                    worker_name,
                    generation,
                    "delivery_ack",
                    delivery_id.as_str(),
                    &event_id,
                ))
                .await;
        }

        let mut kinds = Vec::new();
        while let Ok(frame) = fixture._sdk_out_rx.try_recv() {
            if let Some(kind) = frame.payload.get("kind").and_then(Value::as_str) {
                kinds.push(kind.to_string());
            }
        }
        let observed = Observed {
            kinds,
            fleet_ack_released: fixture.fleet_control_rx.try_recv().is_ok(),
            still_pending: fixture
                .runtime
                .pending_deliveries
                .contains_key(&delivery_id),
            terminal: fixture
                .runtime
                .terminal_failed_deliveries
                .contains(&delivery_id),
        };
        cleanup_worker_registry(fixture.runtime.workers).await;
        observed
    }

    let fallback = drive_verification("timeout_fallback", false).await;
    assert!(
        fallback
            .kinds
            .iter()
            .any(|kind| kind == "delivery_verified"),
        "the fallback must still be reported, just not as an acknowledgement: {:?}",
        fallback.kinds
    );
    for forbidden in [
        "message_delivery_confirmed",
        "delivery_read_ack",
        "delivery_ack",
    ] {
        assert!(
            !fallback.kinds.iter().any(|kind| kind == forbidden),
            "unobserved timeout fallback emitted {forbidden}: {:?}",
            fallback.kinds
        );
    }
    assert!(
        !fallback.fleet_ack_released,
        "unobserved timeout fallback must not release the withheld engine-facing ack"
    );
    assert!(
        !fallback.still_pending,
        "an in-doubt delivery must not stay pending: maintenance would re-inject it"
    );
    assert!(
        fallback.terminal,
        "an in-doubt delivery must be recorded terminal so a late ack cannot confirm it"
    );

    // Control 1: a late `delivery_ack` for the same delivery — the shape that
    // released the fleet ack before this fix — cannot resurrect it.
    let late = drive_verification("timeout_fallback", true).await;
    for forbidden in [
        "message_delivery_confirmed",
        "delivery_read_ack",
        "delivery_ack",
    ] {
        assert!(
            !late.kinds.iter().any(|kind| kind == forbidden),
            "a late ack after an unobserved fallback emitted {forbidden}: {:?}",
            late.kinds
        );
    }
    assert!(
        !late.fleet_ack_released,
        "a late ack after an unobserved fallback must not release the withheld fleet ack"
    );

    // Control 2: the echo arm still confirms, so the assertions above are
    // about the fallback and not about the event being dropped before the
    // handler. (The fleet ack is released by `delivery_ack` on the echo path,
    // not by `delivery_verified`; that is covered by
    // `successful_injection_still_resolves_its_withheld_fleet_ack`.)
    let echo = drive_verification("echo", false).await;
    assert!(
        echo.kinds
            .iter()
            .any(|kind| kind == "message_delivery_confirmed"),
        "an echo-verified delivery must still confirm: {:?}",
        echo.kinds
    );
    assert!(
        !echo.still_pending,
        "a confirmed delivery leaves the pending map"
    );
    assert!(
        !echo.terminal,
        "an observed delivery is confirmed, not recorded as a terminal failure"
    );
}

/// A rollout in the shape Codex ACTUALLY writes once a turn has consumed a
/// queued user input item.
///
/// Both records are the projections captured live from `codex-cli
/// 0.155.0-alpha.9.2` (`codex app-server` → `thread/start` → `turn/start` →
/// `codex queue`), verbatim apart from the marker text and shortened ids; the
/// capture is in
/// `.workflow-artifacts/migrate-native-delivery/phase-1-codex-queue-20260921a/evidence/codex-capture/rollout-consumed-user-item.jsonl`.
///
/// The fixture this replaced wrote `{"text":"<!-- relay-delivery-id:… -->"}`,
/// which no Codex version emits and which names no item kind, so it pinned no
/// real record shape and settled only because the matcher was negative.
/// `crates/broker/src/codex_thread.rs` now refuses it by name.
fn captured_codex_consumed_rollout(delivery_id: &DeliveryId) -> String {
    let marker = format!("relay-delivery-id:{}", delivery_id.as_str());
    format!(
        concat!(
            r#"{{"timestamp":"2026-09-22T18:29:35.389Z","ordinal":8,"type":"response_item","payload":{{"type":"message","id":"msg_01a0ca61","role":"user","content":[{{"type":"input_text","text":"hello from relay\n\n<!-- {marker} -->"}}]}}}}"#,
            "\n",
            r#"{{"timestamp":"2026-09-22T18:29:35.389Z","ordinal":9,"type":"event_msg","payload":{{"type":"item_completed","thread_id":"01a0ca61-60fd","turn_id":"01a0ca61-6208","item":{{"type":"UserMessage","id":"01a0ca61-641d","content":[{{"type":"text","text":"hello from relay\n\n<!-- {marker} -->","text_elements":[]}}]}}}}}}"#,
            "\n",
        ),
        marker = marker
    )
}

/// A native Codex hand-off is not complete until the marker appears in the
/// target thread's own rollout. Once it does, the maintenance path must apply
/// the same terminal effects as an observed PTY acknowledgement: remove the
/// pending entry and publish exactly one confirmation rather than letting the
/// retry cap turn a delivered message into an in-doubt dead letter.
#[tokio::test]
async fn codex_queue_settlement_confirms_and_removes_the_pending_delivery() {
    use crate::delivery::{
        DeliveryBackend, DeliveryBackendFuture, DeliveryError, HandoverState, RouteId, SendRequest,
        SendStatus, SettleRequest, SettleStatus, TransportStatus,
    };

    struct RecordedCodexRoute;

    impl DeliveryBackend for RecordedCodexRoute {
        fn route_id(&self) -> RouteId {
            RouteId::new("codex-queue:thread-settle")
        }

        fn transport_status(&mut self) -> TransportStatus {
            TransportStatus::Available
        }

        fn send<'a>(
            &'a mut self,
            _request: &'a SendRequest,
        ) -> DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>> {
            Box::pin(async { Ok(SendStatus::HandedOver(HandoverState::HandedOver)) })
        }

        fn settle<'a>(
            &'a mut self,
            _request: &'a SettleRequest,
        ) -> DeliveryBackendFuture<'a, SettleStatus> {
            Box::pin(async { SettleStatus::HandedOver(HandoverState::HandedOver) })
        }
    }

    let worker_name = "codex-attached";
    let delivery_id = DeliveryId::new("del_codex_settle");
    let event_id = EventId::new("evt_del_codex_settle");
    let rollout_dir = tempfile::tempdir().expect("rollout temp dir");
    let rollout_path = rollout_dir.path().join("rollout.jsonl");
    std::fs::write(&rollout_path, captured_codex_consumed_rollout(&delivery_id))
        .expect("write observed Codex marker");

    let mut registry = make_worker_registry_with_worker(worker_name).await;
    let handle = registry
        .workers
        .get_mut(worker_name)
        .expect("fixture worker");
    handle.spec.runtime = AgentRuntime::Headless;
    handle.spec.cli = Some("codex".to_string());
    handle.spec.session_id = Some("thread-settle".to_string());
    handle.spec.harness_config = Some(ResolvedHarnessConfig::Native(NativeHarnessConfig {
        command: "codex".to_string(),
        args: Vec::new(),
        cwd: None,
        env: None,
        session_id: "thread-settle".to_string(),
        metadata: Some(HashMap::from([(
            "rollout_path".to_string(),
            Value::String(rollout_path.display().to_string()),
        )])),
    }));

    let mut pending = make_pending_delivery(delivery_id.as_str(), worker_name);
    pending.delivery.event_id = event_id.clone();
    pending.delivery.target = MessageTarget::new(worker_name);
    pending.next_retry_at = Instant::now();
    let mut fixture = worker_event_runtime_fixture(
        registry,
        HashMap::from([(delivery_id.clone(), pending.clone())]),
    );

    let mut route = RecordedCodexRoute;
    fixture
        .runtime
        .delivery_seam
        .send(
            &mut [&mut route],
            SendRequest::relay(WorkerName::from(worker_name), pending.delivery),
        )
        .await
        .expect("precondition: the native hand-off receipt is recorded");

    fixture.runtime.handle_maintenance_tick().await;

    assert!(
        !fixture
            .runtime
            .pending_deliveries
            .contains_key(&delivery_id),
        "an observed Codex marker must settle the pending delivery"
    );
    assert!(
        fixture
            .runtime
            .dead_letters
            .get(delivery_id.as_str())
            .is_none(),
        "a settled Codex delivery must not be dead-lettered"
    );

    let mut confirmations = 0;
    let mut failures = 0;
    while let Ok(frame) = fixture._sdk_out_rx.try_recv() {
        match frame.payload.get("kind").and_then(Value::as_str) {
            Some("message_delivery_confirmed")
                if frame.payload["delivery_id"] == delivery_id.as_str()
                    && frame.payload["event_id"] == event_id.as_str() =>
            {
                confirmations += 1;
            }
            Some("message_delivery_failed")
                if frame.payload["delivery_id"] == delivery_id.as_str() =>
            {
                failures += 1;
            }
            _ => {}
        }
    }
    assert_eq!(confirmations, 1, "settlement must publish one confirmation");
    assert_eq!(failures, 0, "settlement must not publish a failure");

    cleanup_worker_registry(fixture.runtime.workers).await;
}

#[tokio::test]
async fn codex_queue_settlement_does_not_reemit_ack_while_fleet_confirmation_is_held() {
    use crate::delivery::{
        DeliveryBackend, DeliveryBackendFuture, DeliveryError, HandoverState, RouteId, SendRequest,
        SendStatus, SettleRequest, SettleStatus, TransportStatus,
    };

    struct RecordedCodexRoute;

    impl DeliveryBackend for RecordedCodexRoute {
        fn route_id(&self) -> RouteId {
            RouteId::new("codex-queue:thread-held")
        }

        fn transport_status(&mut self) -> TransportStatus {
            TransportStatus::Available
        }

        fn send<'a>(
            &'a mut self,
            _request: &'a SendRequest,
        ) -> DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>> {
            Box::pin(async { Ok(SendStatus::HandedOver(HandoverState::HandedOver)) })
        }

        fn settle<'a>(
            &'a mut self,
            _request: &'a SettleRequest,
        ) -> DeliveryBackendFuture<'a, SettleStatus> {
            Box::pin(async { SettleStatus::HandedOver(HandoverState::HandedOver) })
        }
    }

    let worker_name = "codex-held";
    let lower_deliver = fleet_deliver(5);
    let deliver = fleet_deliver(6);
    let delivery_id = DeliveryId::from(&deliver.delivery_id);
    let lower_delivery_id = DeliveryId::from(&lower_deliver.delivery_id);
    let event_id = EventId::from(&deliver.msg_id);
    let rollout_dir = tempfile::tempdir().expect("rollout temp dir");
    let rollout_path = rollout_dir.path().join("rollout.jsonl");
    std::fs::write(&rollout_path, captured_codex_consumed_rollout(&delivery_id))
        .expect("write observed Codex marker");

    let mut registry = make_worker_registry_with_worker(worker_name).await;
    let handle = registry
        .workers
        .get_mut(worker_name)
        .expect("fixture worker");
    handle.spec.runtime = AgentRuntime::Headless;
    handle.spec.cli = Some("codex".to_string());
    handle.spec.session_id = Some("thread-held".to_string());
    handle.spec.harness_config = Some(ResolvedHarnessConfig::Native(NativeHarnessConfig {
        command: "codex".to_string(),
        args: Vec::new(),
        cwd: None,
        env: None,
        session_id: "thread-held".to_string(),
        metadata: Some(HashMap::from([(
            "rollout_path".to_string(),
            Value::String(rollout_path.display().to_string()),
        )])),
    }));

    let mut pending = make_pending_delivery(delivery_id.as_str(), worker_name);
    pending.delivery.event_id = event_id.clone();
    pending.delivery.target = MessageTarget::new(worker_name);
    pending.withheld_fleet_ack = Some(deliver);
    pending.next_retry_at = Instant::now();
    let mut lower_pending = make_pending_delivery(lower_delivery_id.as_str(), worker_name);
    lower_pending.delivery.event_id = EventId::from(&lower_deliver.msg_id);
    lower_pending.delivery.target = MessageTarget::new(worker_name);
    lower_pending.withheld_fleet_ack = Some(lower_deliver);
    lower_pending.next_retry_at = Instant::now() + Duration::from_secs(60);
    let mut fixture = worker_event_runtime_fixture(
        registry,
        HashMap::from([
            (lower_delivery_id.clone(), lower_pending),
            (delivery_id.clone(), pending.clone()),
        ]),
    );

    let mut route = RecordedCodexRoute;
    fixture
        .runtime
        .delivery_seam
        .send(
            &mut [&mut route],
            SendRequest::relay(WorkerName::from(worker_name), pending.delivery),
        )
        .await
        .expect("precondition: the native hand-off receipt is recorded");

    fixture.runtime.handle_maintenance_tick().await;
    fixture.runtime.handle_maintenance_tick().await;

    let mut sdk_delivery_acks = 0;
    while let Ok(frame) = fixture._sdk_out_rx.try_recv() {
        if frame.payload.get("kind").and_then(Value::as_str) == Some("delivery_ack")
            && frame.payload["delivery_id"] == delivery_id.as_str()
        {
            sdk_delivery_acks += 1;
        }
    }

    assert_eq!(
        sdk_delivery_acks, 1,
        "a held native confirmation must not re-emit delivery_ack on every tick"
    );
    assert!(
        fixture
            .runtime
            .pending_deliveries
            .contains_key(&delivery_id),
        "the held confirmation stays pending until the lower fleet cursor releases it"
    );

    cleanup_worker_registry(fixture.runtime.workers).await;
}

// relay#1310 MUST-NOT-FIRE: once the worker confirms the injection landed
// (echo-verified — the ONLY case in which pty_worker.rs sends the internal
// `delivery_ack`; its bounded timeout fallback deliberately does not, see
// `timeout_fallback_never_confirms_or_acks_an_unobserved_delivery`), the engine
// ack must still fire, with the delivery's own (agent, up_to_seq) — i.e. the
// happy path is unchanged, just correctly gated on confirmation instead of
// write-enqueue.
// Exercises the full wiring: a real handoff through
// `try_inject_pending_relay_message`, followed by a matching worker event
// through `BrokerRuntime::handle_worker_event`, with the assertion made on the
// fleet-control receiver rather than on an extracted helper's return value.
#[tokio::test]
async fn successful_injection_still_resolves_its_withheld_fleet_ack() {
    worker_confirmation_ack_diagnostics(false).await;
}

#[tokio::test]
async fn worker_confirmation_records_closed_control_ack_enqueue_failure() {
    worker_confirmation_ack_diagnostics(true).await;
}

async fn worker_confirmation_ack_diagnostics(closed: bool) {
    let worker_name = "worker-a";
    let registry = make_worker_registry_with_worker(worker_name).await;
    let generation = registry.workers[worker_name].generation;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    if closed {
        fixture.fleet_control_rx.close();
    }
    let deliver = fleet_deliver(1);
    let msg = held_fleet_message(&deliver);

    let delivery_id = try_inject_pending_relay_message(
        &mut fixture.runtime.workers,
        &mut fixture.runtime.pending_deliveries,
        worker_name,
        &msg,
        Duration::from_secs(2),
        Some(deliver.clone()),
        Some(deliver.seq),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("a registered worker should accept the handoff");

    assert_eq!(
        delivery_id.as_str(),
        deliver.delivery_id,
        "fleet identity must reach the worker unchanged so a replay can be deduplicated"
    );

    assert!(
        fixture
            .runtime
            .pending_deliveries
            .get(&delivery_id)
            .expect("the delivery must be tracked pending the worker's confirmation")
            .withheld_fleet_ack
            .is_some(),
        "a successful handoff must still withhold the ack pending echo confirmation"
    );

    fixture
        .runtime
        .handle_worker_event(delivery_lifecycle_worker_event(
            worker_name,
            generation,
            "delivery_ack",
            delivery_id.as_str(),
            deliver.msg_id.as_str(),
        ))
        .await;

    if !closed {
        match tokio::time::timeout(Duration::from_secs(1), fixture.fleet_control_rx.recv()).await {
            Ok(Some(FleetControlCommand::Send(BrokerToRelaycast::DeliveryAck(ack)))) => {
                assert_eq!(ack.agent, deliver.agent);
                assert_eq!(ack.up_to_seq, deliver.seq);
            }
            other => {
                panic!("expected worker confirmation to emit the withheld fleet ack, got {other:?}")
            }
        }
    }
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    assert!(!fixture
        .runtime
        .pending_deliveries
        .contains_key(&delivery_id));

    // Replayed confirmation cannot enqueue or count the same ACK twice.
    fixture
        .runtime
        .handle_worker_event(delivery_lifecycle_worker_event(
            worker_name,
            generation,
            "delivery_ack",
            delivery_id.as_str(),
            deliver.msg_id.as_str(),
        ))
        .await;
    let snapshot = fixture
        .runtime
        .node_delivery_probe
        .snapshot_with_token(true);
    assert_eq!(snapshot["acks"]["enqueued"], if closed { 0 } else { 1 });
    assert_eq!(
        snapshot["acks"]["enqueue_failed"],
        if closed { 1 } else { 0 }
    );
    assert_eq!(snapshot["acks"]["sent"], 0);
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    cleanup_worker_registry(fixture.runtime.workers).await;
}

// relay#1543 restart-ordering MUST-NOT-FIRE / MUST-FIRE boundary. The
// confirmation order is explicit: HashMap iteration never decides which
// delivery lands first. With both restored sequences pending, confirming seq
// 42 first must not emit a cumulative ack that lies about seq 41. Once seq 41
// confirms, the held seq 42 confirmation must be released by one cumulative
// ack through seq 42.
#[test]
fn restored_out_of_order_confirmation_waits_for_the_lower_sequence() {
    // Use a mid-stream cursor to exercise the restart-only "adopt first
    // position" branch rather than accidentally relying on a fresh seq-1
    // stream.
    let first = fleet_deliver(41);
    let second = fleet_deliver(42);
    let mut first_pending = pending_delivery(
        "worker-a",
        first.delivery_id.as_str(),
        first.msg_id.as_str(),
    );
    first_pending.withheld_fleet_ack = Some(first.clone());
    let mut second_pending = pending_delivery(
        "worker-a",
        second.delivery_id.as_str(),
        second.msg_id.as_str(),
    );
    second_pending.withheld_fleet_ack = Some(second.clone());
    let mut pending_deliveries = HashMap::from([
        (DeliveryId::from(&first.delivery_id), first_pending),
        (DeliveryId::from(&second.delivery_id), second_pending),
    ]);
    let mut fleet_delivery_book = FleetDeliveryBook::default();

    let (confirmed_second, second_ack) =
        super::fleet::confirm_pending_delivery_and_resolve_fleet_ack(
            &mut pending_deliveries,
            second.delivery_id.as_str(),
            Some(second.msg_id.as_str()),
            "worker-a",
            "delivery_ack",
            &mut fleet_delivery_book,
        );
    assert!(confirmed_second.is_some());
    assert_eq!(
        second_ack, None,
        "seq 42 must remain withheld while restored seq 41 is still unconfirmed"
    );
    assert!(
        pending_deliveries.contains_key(second.delivery_id.as_str()),
        "the held seq 42 confirmation must remain durable until seq 41 confirms"
    );
    assert!(
        fleet_delivery_book.is_delivery_confirmation_held(&second),
        "maintenance must be able to distinguish the confirmed hold from a retryable delivery"
    );
    assert_eq!(
        fleet_delivery_book.acked_up_to_seq(first.agent_id.as_str()),
        first.seq - 1,
        "the restored cursor must remain immediately below the lowest pending sequence"
    );

    let (confirmed_first, first_ack) = super::fleet::confirm_pending_delivery_and_resolve_fleet_ack(
        &mut pending_deliveries,
        first.delivery_id.as_str(),
        Some(first.msg_id.as_str()),
        "worker-a",
        "delivery_ack",
        &mut fleet_delivery_book,
    );
    assert!(confirmed_first.is_some());
    assert_eq!(
        first_ack,
        Some((first.agent.clone(), second.seq)),
        "confirming seq 41 must release its already-confirmed seq 42 sibling"
    );
    assert!(
        pending_deliveries.is_empty(),
        "the cumulative seq 42 ack must release both pending entries"
    );
    assert_eq!(
        fleet_delivery_book.acked_up_to_seq(first.agent_id.as_str()),
        second.seq
    );
    assert!(!fleet_delivery_book.is_delivery_confirmation_held(&second));
}

// relay#1543 restart-ordering MUST-NOT-FIRE / MUST-FIRE boundary across a
// second restart. Once seq 41 is worker-confirmed and cumulatively acked, the
// surviving seq 42 entry must no longer persist 41 as its first required
// sequence. Otherwise a fresh delivery book after the next restart waits for
// an already-acked confirmation that can never arrive and withholds seq 42
// forever.
#[test]
fn confirmed_lower_sequence_advances_surviving_ack_floor_before_restart() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("pending.json");
    let first = fleet_deliver(41);
    let second = fleet_deliver(42);
    let mut first_pending = pending_delivery(
        "worker-a",
        first.delivery_id.as_str(),
        first.msg_id.as_str(),
    );
    first_pending.withheld_fleet_ack = Some(first.clone());
    let mut second_pending = pending_delivery(
        "worker-a",
        second.delivery_id.as_str(),
        second.msg_id.as_str(),
    );
    second_pending.withheld_fleet_ack = Some(second.clone());
    let pending_deliveries = HashMap::from([
        (DeliveryId::from(&first.delivery_id), first_pending),
        (DeliveryId::from(&second.delivery_id), second_pending),
    ]);
    super::save_pending_deliveries(&path, &pending_deliveries).expect("save first snapshot");

    let mut after_first_restart = load_pending_deliveries(&path);
    assert_eq!(
        after_first_restart[second.delivery_id.as_str()].withheld_fleet_ack_floor,
        Some(first.seq),
        "the first restart must preserve the lowest still-unconfirmed sequence"
    );
    let mut first_delivery_book = FleetDeliveryBook::default();
    let (_, first_ack) = super::fleet::confirm_pending_delivery_and_resolve_fleet_ack(
        &mut after_first_restart,
        first.delivery_id.as_str(),
        Some(first.msg_id.as_str()),
        "worker-a",
        "delivery_ack",
        &mut first_delivery_book,
    );
    assert_eq!(first_ack, Some((first.agent.clone(), first.seq)));
    assert_eq!(
        after_first_restart[second.delivery_id.as_str()].withheld_fleet_ack_floor,
        Some(second.seq),
        "acking seq 41 must advance the surviving entry's persisted floor to seq 42"
    );
    super::save_pending_deliveries(&path, &after_first_restart)
        .expect("save snapshot after lower confirmation");

    let mut after_second_restart = load_pending_deliveries(&path);
    let mut second_delivery_book = FleetDeliveryBook::default();
    let (_, second_ack) = super::fleet::confirm_pending_delivery_and_resolve_fleet_ack(
        &mut after_second_restart,
        second.delivery_id.as_str(),
        Some(second.msg_id.as_str()),
        "worker-a",
        "delivery_ack",
        &mut second_delivery_book,
    );
    assert_eq!(
        second_ack,
        Some((second.agent.clone(), second.seq)),
        "seq 42 must ack normally after restart instead of waiting forever for acked seq 41"
    );
    assert!(after_second_restart.is_empty());
}

// The ordering gap itself must survive another restart after the lower entry
// has left the pending map. Otherwise the remaining higher sequence would be
// mistaken for a new baseline and could once again cumulatively ACK the
// dead-lettered lower delivery.
#[tokio::test]
async fn restored_ack_floor_survives_lower_failure_and_a_second_restart() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("pending.json");
    let first = fleet_deliver(41);
    let second = fleet_deliver(42);
    let mut first_pending = pending_delivery(
        "worker-a",
        first.delivery_id.as_str(),
        first.msg_id.as_str(),
    );
    first_pending.withheld_fleet_ack = Some(first.clone());
    let mut second_pending = pending_delivery(
        "worker-a",
        second.delivery_id.as_str(),
        second.msg_id.as_str(),
    );
    second_pending.withheld_fleet_ack = Some(second.clone());
    let pending_deliveries = HashMap::from([
        (DeliveryId::from(&first.delivery_id), first_pending),
        (DeliveryId::from(&second.delivery_id), second_pending),
    ]);
    super::save_pending_deliveries(&path, &pending_deliveries).expect("save first snapshot");

    let mut after_first_restart = load_pending_deliveries(&path);
    assert_eq!(
        after_first_restart[second.delivery_id.as_str()].withheld_fleet_ack_floor,
        Some(first.seq)
    );

    // Drive the actual retry-exhaustion/dead-letter path. Removing seq 41
    // directly would not prove that the terminal path preserves seq 42's
    // persisted floor.
    let first_id = DeliveryId::from(&first.delivery_id);
    let first_pending = after_first_restart
        .get_mut(&first_id)
        .expect("restored lower delivery");
    first_pending.attempts = MAX_DELIVERY_RETRIES;
    first_pending.failed_attempts = MAX_DELIVERY_RETRIES;
    first_pending.last_error = Some("failed writing frame".to_string());
    let (worker_event_tx, _worker_event_rx) = mpsc::channel::<WorkerEvent>(4);
    let mut workers = WorkerRegistry::new(
        worker_event_tx,
        Vec::new(),
        dir.path().join("worker-logs"),
        Instant::now(),
    );
    let outcome = retry_pending_delivery(
        &first_id,
        &mut workers,
        &mut after_first_restart,
        Duration::from_millis(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("exhausted lower delivery should classify as terminal");
    let (sdk_out_tx, _sdk_out_rx) = mpsc::channel(4);
    let mut dead_letters = DeadLetterStore::default();
    emit_delivery_attempt_outcome(&sdk_out_tx, &mut dead_letters, &first_id, true, outcome)
        .await
        .expect("terminal lower delivery should enter the dead-letter store");
    assert!(
        dead_letters.get(first.delivery_id.as_str()).is_some(),
        "the real terminal path must dead-letter seq 41"
    );
    assert!(!after_first_restart.contains_key(&first_id));
    super::save_pending_deliveries(&path, &after_first_restart)
        .expect("save snapshot after lower terminal failure");

    let mut after_second_restart = load_pending_deliveries(&path);
    assert_eq!(
        after_second_restart[second.delivery_id.as_str()].withheld_fleet_ack_floor,
        Some(first.seq),
        "the higher entry must retain the failed lower sequence as its ACK floor"
    );
    let mut fleet_delivery_book = FleetDeliveryBook::default();
    let (_, higher_ack) = super::fleet::confirm_pending_delivery_and_resolve_fleet_ack(
        &mut after_second_restart,
        second.delivery_id.as_str(),
        Some(second.msg_id.as_str()),
        "worker-a",
        "delivery_ack",
        &mut fleet_delivery_book,
    );
    assert_eq!(
        higher_ack, None,
        "seq 42 must still not ACK through the absent, failed seq 41"
    );
    assert!(after_second_restart.contains_key(second.delivery_id.as_str()));

    let mut retried_first = pending_delivery(
        "worker-a",
        first.delivery_id.as_str(),
        first.msg_id.as_str(),
    );
    retried_first.withheld_fleet_ack = Some(first.clone());
    after_second_restart.insert(DeliveryId::from(&first.delivery_id), retried_first);
    let (_, released_ack) = super::fleet::confirm_pending_delivery_and_resolve_fleet_ack(
        &mut after_second_restart,
        first.delivery_id.as_str(),
        Some(first.msg_id.as_str()),
        "worker-a",
        "delivery_ack",
        &mut fleet_delivery_book,
    );
    assert_eq!(released_ack, Some((first.agent.clone(), second.seq)));
    assert!(after_second_restart.is_empty());
}

// The paired happy-path boundary: adding an ordering hold must not turn
// ordinary in-order worker confirmations into acknowledgements that never
// fire.
#[test]
fn in_order_confirmation_still_acknowledges_each_sequence_immediately() {
    let mut fleet_delivery_book = FleetDeliveryBook::default();
    let mut pending_deliveries = HashMap::new();

    for expected_seq in [1, 2] {
        let deliver = fleet_deliver(expected_seq);
        let mut pending = pending_delivery(
            "worker-a",
            deliver.delivery_id.as_str(),
            deliver.msg_id.as_str(),
        );
        pending.withheld_fleet_ack = Some(deliver.clone());
        pending_deliveries.insert(DeliveryId::from(&deliver.delivery_id), pending);

        let (confirmed, resolved) = super::fleet::confirm_pending_delivery_and_resolve_fleet_ack(
            &mut pending_deliveries,
            deliver.delivery_id.as_str(),
            Some(deliver.msg_id.as_str()),
            "worker-a",
            "delivery_ack",
            &mut fleet_delivery_book,
        );
        assert!(confirmed.is_some());
        assert_eq!(
            resolved,
            Some((deliver.agent.clone(), expected_seq)),
            "an in-order confirmation must ack without waiting for another event"
        );
        assert!(pending_deliveries.is_empty());
    }
}

// A worker delivery_ack whose event_id doesn't match the withheld delivery's
// event_id (stale or reused delivery_id) must not resolve into an engine
// ack. The matching itself is `clear_pending_delivery_if_event_matches`'s
// job (see `clear_pending_delivery_returns_none_for_stale_event_id` below)
// — this exercises that guard against a real pending delivery that actually
// carries a withheld ack, then feeds its *return value* into
// `resolve_pending_fleet_ack` exactly as `handle_worker_event`'s
// `delivery_ack` arm does, so a regression that made the guard incorrectly
// clear on a mismatch would surface here as a resolved ack. See relay#1543
// tests.rs:1309's review thread — the prior version passed a hardcoded
// `None` straight to `resolve_pending_fleet_ack`, which is `None` for every
// implementation and never exercised the guard at all.
#[tokio::test]
async fn mismatched_event_id_leaves_nothing_for_resolve_pending_fleet_ack() {
    let mut pending = make_pending_delivery("del_reused", "worker-a");
    pending.withheld_fleet_ack = Some(withheld_ack_for("del_reused"));
    let mut pending_deliveries = HashMap::from([(DeliveryId::new("del_reused"), pending)]);

    let cleared = clear_pending_delivery_if_event_matches(
        &mut pending_deliveries,
        "del_reused",
        Some("evt_stale_reused_id"),
        "worker-a",
        "delivery_ack",
    );
    assert!(
        cleared.is_none(),
        "a mismatched event_id must not clear the pending delivery"
    );
    assert!(
        pending_deliveries.contains_key("del_reused"),
        "a mismatched event must not consume the withheld entry"
    );

    let mut fleet_delivery_book = FleetDeliveryBook::default();
    assert_eq!(
        super::fleet::resolve_pending_fleet_ack(cleared.as_ref(), &mut fleet_delivery_book),
        None,
        "no pending delivery (because the event_id guard declined to clear one) means nothing to resolve"
    );
}

#[tokio::test]
async fn delivery_retry_fails_promptly_when_recipient_is_gone() {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let mut workers = WorkerRegistry::new(
        tx,
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let mut pending_deliveries = HashMap::from([(
        DeliveryId::new("del_gone"),
        PendingDelivery {
            worker_name: WorkerName::from("ghost"),
            delivery: RelayDelivery {
                delivery_id: DeliveryId::new("del_gone"),
                event_id: EventId::new("evt_gone"),
                workspace_id: Some(WorkspaceId::new("ws_demo")),
                workspace_alias: Some(WorkspaceAlias::new("Demo")),
                from: "Lead".to_string(),
                target: MessageTarget::new("Worker"),
                body: "hello".to_string(),
                thread_id: None,
                priority: Some(2),
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 3,
            failed_attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: Some("failed writing frame".to_string()),
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    )]);

    let outcome = retry_pending_delivery(
        &DeliveryId::new("del_gone"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("retry should classify missing recipient");

    match outcome {
        DeliveryAttemptOutcome::Failed {
            pending,
            last_error,
        } => {
            assert_eq!(pending.worker_name, WorkerName::from("ghost"));
            assert_eq!(pending.delivery.delivery_id, DeliveryId::new("del_gone"));
            assert_eq!(pending.delivery.event_id, EventId::new("evt_gone"));
            assert_eq!(pending.delivery.from, "Lead");
            assert_eq!(pending.delivery.target, MessageTarget::new("Worker"));
            assert_eq!(pending.attempts, 3);
            assert_eq!(last_error, "recipient gone");
        }
        other => panic!("missing recipient should fail terminally, got {other:?}"),
    }
    assert!(
        pending_deliveries.is_empty(),
        "terminal failed deliveries are removed so they cannot retry forever"
    );
}

#[tokio::test]
async fn initial_delivery_failure_stays_owned_until_dead_lettered() {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let mut workers = WorkerRegistry::new(
        tx,
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let mut pending_deliveries = HashMap::new();

    let error = super::queue_and_try_delivery_raw(
        &mut workers,
        &mut pending_deliveries,
        "ghost",
        "evt_initial_failure",
        "orchestrator",
        "ghost",
        "must remain auditable",
        None,
        Some(WorkspaceId::new("ws_demo")),
        None,
        2,
        MessageInjectionMode::Wait,
        Duration::from_millis(1),
        None,
        None,
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect_err("missing recipient should fail the initial handoff");

    assert!(error.to_string().contains("recipient gone"));
    assert_eq!(
        pending_deliveries.len(),
        1,
        "the no-DLQ raw path must retain ownership for the maintenance dead-letter path"
    );
    let pending = pending_deliveries
        .values()
        .next()
        .expect("failed initial delivery remains pending");
    assert_eq!(
        pending.delivery.event_id,
        EventId::new("evt_initial_failure")
    );
    assert_eq!(pending.delivery.body, "must remain auditable");
    assert_eq!(pending.attempts, 0);
    assert_eq!(pending.failed_attempts, MAX_DELIVERY_RETRIES);
    assert_eq!(pending.last_error.as_deref(), Some("recipient gone"));
    let delivery_id = pending.delivery.delivery_id.clone();

    let outcome = retry_pending_delivery(
        &delivery_id,
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("terminal retained delivery should dead-letter on maintenance retry");
    match outcome {
        DeliveryAttemptOutcome::Failed {
            pending,
            last_error,
        } => {
            assert_eq!(pending.attempts, 0);
            assert_eq!(pending.failed_attempts, MAX_DELIVERY_RETRIES);
            assert_eq!(last_error, "recipient gone");
        }
        other => panic!("terminal retained delivery should fail once, got {other:?}"),
    }
    assert!(
        pending_deliveries.is_empty(),
        "terminal retained delivery must be removed before dead-lettering"
    );
}

#[tokio::test]
async fn delivery_retry_committed_writer_failure_stops_without_dead_letter() {
    let worker_name = "worker-blip";
    let mut workers = make_worker_registry_with_worker(worker_name).await;
    {
        let handle = workers
            .workers
            .get_mut(worker_name)
            .expect("present worker handle");
        let _ = handle.child.start_kill();
        let _ = handle.child.wait().await;
    }
    assert!(
        workers.has_worker(worker_name),
        "transient-blip regression must keep the recipient present"
    );

    let mut pending_deliveries = HashMap::from([(
        DeliveryId::new("del_blip"),
        PendingDelivery {
            worker_name: WorkerName::from(worker_name),
            delivery: RelayDelivery {
                delivery_id: DeliveryId::new("del_blip"),
                event_id: EventId::new("evt_blip"),
                workspace_id: Some(WorkspaceId::new("ws_demo")),
                workspace_alias: Some(WorkspaceAlias::new("Demo")),
                from: "orchestrator".to_string(),
                target: MessageTarget::new(worker_name),
                body: "transient auth blip".to_string(),
                thread_id: None,
                priority: Some(2),
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 0,
            failed_attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    )]);

    let outcome = retry_pending_delivery(
        &DeliveryId::new("del_blip"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("transient delivery write errors should be classified");
    match outcome {
        DeliveryAttemptOutcome::TerminalInDoubt {
            pending,
            last_error,
        } => {
            assert_eq!(pending.delivery.delivery_id.as_str(), "del_blip");
            assert!(
                last_error.contains("delivery backend error after possible write"),
                "terminal doubt should preserve the committed error boundary"
            );
        }
        other => panic!("committed PTY writer failure should stop in doubt, got {other:?}"),
    }
    assert!(
        pending_deliveries.is_empty(),
        "possible-write failures must not stay pending for retry"
    );
}

#[tokio::test]
async fn delivery_retry_success_clears_stale_last_error() {
    let worker_name = "worker-clear-error";
    let mut workers = make_worker_registry_with_worker(worker_name).await;
    let mut pending_deliveries = HashMap::from([(
        DeliveryId::new("del_clear"),
        PendingDelivery {
            worker_name: WorkerName::from(worker_name),
            delivery: RelayDelivery {
                delivery_id: DeliveryId::new("del_clear"),
                event_id: EventId::new("evt_clear"),
                workspace_id: Some(WorkspaceId::new("ws_demo")),
                workspace_alias: Some(WorkspaceAlias::new("Demo")),
                from: "orchestrator".to_string(),
                target: MessageTarget::new(worker_name),
                body: "clear stale error".to_string(),
                thread_id: None,
                priority: Some(2),
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 1,
            failed_attempts: 1,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: Some("old transient failure".to_string()),
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    )]);

    let outcome = retry_pending_delivery(
        &DeliveryId::new("del_clear"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("live worker should accept retry");

    assert!(matches!(outcome, DeliveryAttemptOutcome::Attempted { .. }));
    assert_eq!(
        pending_deliveries
            .get("del_clear")
            .and_then(|pending| pending.last_error.as_ref()),
        None
    );
    assert_eq!(
        pending_deliveries["del_clear"].failed_attempts, 0,
        "a successful broker-to-worker handoff resets consecutive failures"
    );
    cleanup_worker_registry(workers).await;
}

#[tokio::test]
async fn wait_delivery_successful_handoffs_do_not_exhaust_failure_budget() {
    let worker_name = "worker-busy-wait";
    let mut workers = make_worker_registry_with_worker(worker_name).await;
    let mut pending = make_pending_delivery("del_busy_wait", worker_name);
    pending.attempts = MAX_DELIVERY_RETRIES - 1;
    pending.delivery.injection_mode = MessageInjectionMode::Wait;
    let mut pending_deliveries = HashMap::from([(pending.delivery.delivery_id.clone(), pending)]);

    let first = retry_pending_delivery(
        &DeliveryId::new("del_busy_wait"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_secs(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("live worker should accept the tenth handoff");
    assert!(matches!(
        first,
        DeliveryAttemptOutcome::Attempted {
            attempts: MAX_DELIVERY_RETRIES,
            ..
        }
    ));

    let second = retry_pending_delivery(
        &DeliveryId::new("del_busy_wait"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_secs(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .expect("a successful handoff must remain redeliverable while its wait ack is pending");

    assert!(matches!(
        second,
        DeliveryAttemptOutcome::Attempted {
            attempts,
            ..
        } if attempts == MAX_DELIVERY_RETRIES + 1
    ));
    let pending = pending_deliveries
        .get("del_busy_wait")
        .expect("successful wait handoffs must not be dead-lettered");
    assert!(
        pending.next_retry_at.duration_since(Instant::now()) > Duration::from_secs(60),
        "wait-mode acknowledgements need a minutes-scale verification window"
    );

    cleanup_worker_registry(workers).await;
}

fn extract_kind_literals(source: &str) -> BTreeSet<String> {
    let marker = "\"kind\"";
    let mut kinds = BTreeSet::new();
    let mut cursor = 0;
    while let Some(offset) = source[cursor..].find(marker) {
        let mut start = cursor + offset + marker.len();
        if start >= source.len() {
            break;
        }
        if !source[start..].starts_with(':') {
            cursor = start;
            continue;
        }
        start += 1;
        while start < source.len() && source.as_bytes()[start].is_ascii_whitespace() {
            start += 1;
        }
        if start >= source.len() || source.as_bytes()[start] != b'"' {
            cursor = start;
            continue;
        }
        start += 1;
        if let Some(end) = source[start..].find('"') {
            let candidate = &source[start..start + end];
            if !candidate.is_empty()
                && candidate
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
            {
                kinds.insert(candidate.to_string());
            }
        }
        cursor = start;
        if cursor >= source.len() {
            break;
        }
    }
    kinds
}

#[test]
fn parses_channels() {
    assert_eq!(channels_from_csv("general,ops"), vec!["general", "ops"]);
}

#[test]
fn channel_normalization() {
    assert_eq!(normalize_channel("general"), "#general");
    assert_eq!(normalize_channel("#ops"), "#ops");
}

#[test]
fn normalize_initial_task_drops_empty_values() {
    assert_eq!(normalize_initial_task(None), None);
    assert_eq!(normalize_initial_task(Some(String::new())), None);
    assert_eq!(normalize_initial_task(Some("   ".to_string())), None);
}

#[test]
fn normalize_initial_task_keeps_non_empty_values() {
    assert_eq!(
        normalize_initial_task(Some("Ship the patch".to_string())),
        Some("Ship the patch".to_string())
    );
}

#[test]
fn exit_after_task_instruction_appends_clean_exit_contract() {
    let task = apply_exit_after_task_instruction(Some("Ship the patch".to_string()));
    assert!(task.starts_with("Ship the patch\n\n## Post-task exit"));
    assert!(task.contains("output `/exit` on its own line"));
}

#[test]
fn resolve_exit_after_task_maps_spawn_mode_and_explicit_flag() {
    // Interactive / absent spawn_mode keeps the agent running.
    assert!(!resolve_exit_after_task(None, None).expect("absent is valid"));
    assert!(!resolve_exit_after_task(Some("interactive"), None).expect("interactive is valid"));
    assert!(!resolve_exit_after_task(Some(""), None).expect("blank is valid"));

    // Every accepted task-exit synonym flips the flag on, case/spacing-insensitive.
    for mode in [
        "task_exit",
        "task-exit",
        "single_shot",
        "single-shot",
        " Task_Exit ",
    ] {
        assert!(
            resolve_exit_after_task(Some(mode), None).expect("task-exit synonym is valid"),
            "spawn_mode '{mode}' should resolve to exit_after_task=true"
        );
    }

    // An explicit exit_after_task=true wins even without a spawn_mode.
    assert!(resolve_exit_after_task(None, Some(true)).expect("explicit flag is valid"));
    // and does not override an interactive spawn_mode back off.
    assert!(resolve_exit_after_task(Some("interactive"), Some(true)).expect("explicit flag wins"));
    assert!(!resolve_exit_after_task(Some("interactive"), Some(false)).expect("both off"));
}

#[test]
fn resolve_exit_after_task_rejects_unknown_spawn_mode() {
    let error = resolve_exit_after_task(Some("detached"), None)
        .expect_err("unknown spawn_mode must be rejected");
    assert!(
        error.contains("unsupported spawnMode 'detached'"),
        "error should name the bad mode; got {error}"
    );
}

#[test]
fn relaycast_ws_spawn_token_extracts_agent_token() {
    let value = json!({
        "type": "agent.spawn_requested",
        "agent": {
            "name": "worker-a",
            "token": "at_live_worker"
        }
    });

    assert_eq!(
        relaycast_ws_spawn_token(&value),
        Some("at_live_worker".to_string())
    );
}

#[test]
fn relaycast_ws_spawn_name_only_control_key_skips_second_name_dedup() {
    // A control key keyed on the agent name matches the local spawn-echo key,
    // so the second (name-based) dedup must NOT fire.
    let control_key = relaycast_spawn_control_dedup_key("ws_1", "worker-a");
    let local_key = relaycast_spawn_control_dedup_key("ws_1", "worker-a");

    assert_eq!(control_key, local_key);
    assert!(!relaycast_ws_should_apply_local_spawn_echo_dedup(
        Some(control_key.as_str()),
        &local_key
    ));
}

#[test]
fn relaycast_ws_spawn_event_id_echo_still_uses_local_name_dedup() {
    // A control key keyed on an event id differs from the name-based local
    // spawn-echo key, so the local dedup must still apply.
    let control_key = "control:ws_1:agent.spawn_requested:evt_123".to_string();
    let local_key = relaycast_spawn_control_dedup_key("ws_1", "worker-a");

    assert_ne!(control_key, local_key);
    assert!(relaycast_ws_should_apply_local_spawn_echo_dedup(
        Some(control_key.as_str()),
        &local_key
    ));

    let now = Instant::now();
    let mut dedup = DedupCache::new(Duration::from_secs(60), 16);
    assert!(dedup.insert_if_new(&local_key, now));
    assert!(dedup.insert_if_new(&control_key, now + Duration::from_secs(1)));
    assert!(!dedup.insert_if_new(&local_key, now + Duration::from_secs(2)));
}

#[test]
fn unknown_worker_error_message_matches_release_failures() {
    assert!(is_unknown_worker_error_message("unknown worker 'worker-a'"));
    assert!(is_unknown_worker_error_message(
        "failed to release 'worker-a': unknown worker 'worker-a'"
    ));
    assert!(!is_unknown_worker_error_message("failed to bind api port"));
}

#[test]
fn relaycast_self_control_target_matches_aliases_case_insensitively() {
    let self_names = HashSet::from([
        "relay-broker".to_string(),
        "relay-broker@workspace".to_string(),
    ]);

    assert!(is_relaycast_self_control_target(
        "Relay-Broker",
        "relay-broker",
        &self_names
    ));
    assert!(is_relaycast_self_control_target(
        "@relay-broker@workspace",
        "relay-broker",
        &self_names
    ));
    assert!(!is_relaycast_self_control_target(
        "worker-a",
        "relay-broker",
        &self_names
    ));
}

#[tokio::test]
async fn contract_health_fixture_requires_rich_listen_health_shape() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/health-fixtures.json"
    ))
    .expect("health fixture should be valid JSON");
    let expected_shape = fixture
        .get("health_response")
        .and_then(Value::as_object)
        .expect("health fixture must include health_response object");

    let actual = crate::listen_api::listen_api_health_payload(None, vec![]);

    for required_key in expected_shape.keys() {
        // TODO(contract-wave1-health-shape): listen-mode /health should
        // implement the shared BrokerHealthResponse contract fields.
        assert!(
            actual.get(required_key).is_some(),
            "listen /health response is missing required contract field: {}",
            required_key
        );
    }
}

#[tokio::test]
async fn contract_startup_429_fixture_requires_degraded_health_status() {
    let _guard = env_test_lock().lock().expect("env test lock");
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/health-fixtures.json"
    ))
    .expect("health fixture should be valid JSON");
    let expected = fixture
        .get("wave0_startup_429_degraded")
        .and_then(|v| v.get("expected_health_status"))
        .and_then(Value::as_str)
        .expect("health fixture must include expected degraded health status");
    let startup_error_code = fixture
        .get("wave0_startup_429_degraded")
        .and_then(|v| v.get("error"))
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .expect("health fixture must include startup error code");
    std::env::set_var("AGENT_RELAY_STARTUP_ERROR_CODE", startup_error_code);
    let actual = crate::listen_api::listen_api_health_payload(None, vec![])
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    std::env::remove_var("AGENT_RELAY_STARTUP_ERROR_CODE");

    assert_eq!(
        actual, expected,
        "listen /health status \"{}\" does not match startup 429 degraded contract \"{}\"",
        actual, expected
    );
}

#[test]
fn contract_replay_fixture_requires_replay_route_exposure() {
    let replay_fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/replay-fixtures.json"
    ))
    .expect("replay fixture should be valid JSON");
    assert!(
        replay_fixture.get("replay_cursor_request").is_some(),
        "replay fixture must include replay_cursor_request"
    );
    assert!(
        replay_fixture.get("replay_response").is_some(),
        "replay fixture must include replay_response"
    );

    let source = include_str!("../listen_api.rs");
    assert!(
        source.contains(".route(\"/api/events/replay\""),
        "listen API router does not expose /api/events/replay"
    );
}

#[test]
fn worker_reported_delivery_failures_use_the_dead_letter_path() {
    let source = include_str!("worker_events.rs");
    let failure_branch = source
        .split("msg_type == \"delivery_failed\"")
        .nth(1)
        .expect("worker_events.rs must include delivery_failed handling");
    assert!(
        failure_branch.contains("emit_dropped_delivery_failures"),
        "worker-reported terminal failures must be retained in the dead-letter store"
    );
}

#[test]
fn contract_broadcast_whitelist_fixture_requires_filtering_to_required_kinds() {
    let event_fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/event-fixtures.json"
    ))
    .expect("event fixture should be valid JSON");
    let required = event_fixture
        .get("wave0_broadcast_whitelist")
        .and_then(|v| v.get("required_kinds"))
        .and_then(Value::as_array)
        .expect("event fixture must include wave0_broadcast_whitelist.required_kinds")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<String>>();

    let emitted = extract_kind_literals(concat!(
        include_str!("api.rs"),
        include_str!("maintenance.rs"),
        include_str!("relaycast_events.rs"),
        include_str!("worker_events.rs"),
    ));

    assert!(
        required.is_subset(&emitted),
        "broker source is missing required broadcast kinds; expected {:?}, got {:?}",
        required,
        emitted
    );
}

#[test]
fn build_thread_infos_groups_channel_messages() {
    let messages = vec![
        json!({
            "from": "broker",
            "target": "#general",
            "text": "outbound",
            "timestamp": "2026-02-23T10:00:00Z",
        }),
        json!({
            "from": "Lead",
            "target": "#general",
            "text": "inbound",
            "timestamp": "2026-02-23T10:01:00Z",
        }),
    ];
    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(&messages, &self_names);

    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].thread_id, "#general");
    assert_eq!(threads[0].name, "#general");
    assert_eq!(threads[0].unread_count, 1);
    assert_eq!(threads[0].last_message.as_deref(), Some("inbound"));
}

#[test]
fn build_thread_infos_groups_direct_messages_case_insensitively() {
    let messages = vec![
        json!({
            "from": "BROKER",
            "to": "WorkerA",
            "text": "ping",
            "timestamp": "2026-02-23T10:00:00Z",
        }),
        json!({
            "from": "workera",
            "to": "broker",
            "text": "pong",
            "timestamp": "2026-02-23T10:01:00Z",
        }),
    ];
    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(&messages, &self_names);

    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].thread_id, "direct:broker:workera");
    assert_eq!(threads[0].name, "workera");
    assert_eq!(threads[0].unread_count, 1);
    assert_eq!(threads[0].last_message.as_deref(), Some("pong"));
}

#[test]
fn build_thread_infos_uses_dm_conversation_id_and_sender_name() {
    let messages = vec![json!({
        "from": "Planner",
        "conversation_id": "conv_123",
        "text": "dm payload",
        "timestamp": "2026-02-23T10:01:00Z",
    })];
    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(&messages, &self_names);

    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].thread_id, "conv_123");
    assert_eq!(threads[0].name, "Planner");
    assert_eq!(threads[0].unread_count, 1);
}

#[test]
fn build_thread_infos_shows_dms_between_non_broker_agents() {
    let messages = vec![
        json!({
            "from": "WorkerA",
            "conversation_id": "dm_456",
            "participants": ["WorkerA", "WorkerB"],
            "text": "hello WorkerB",
            "timestamp": "2026-02-23T10:00:00Z",
        }),
        json!({
            "from": "WorkerB",
            "conversation_id": "dm_456",
            "participants": ["WorkerA", "WorkerB"],
            "text": "hi WorkerA",
            "timestamp": "2026-02-23T10:01:00Z",
        }),
    ];
    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(&messages, &self_names);

    assert_eq!(threads.len(), 1, "should group into one conversation");
    assert_eq!(threads[0].thread_id, "dm_456");
    assert_eq!(threads[0].name, "WorkerA ↔ WorkerB");
    assert_eq!(
        threads[0].unread_count, 2,
        "both messages unread (neither from broker)"
    );
    assert_eq!(threads[0].last_message.as_deref(), Some("hi WorkerA"));
}

#[test]
fn build_thread_infos_dm_with_participants_filters_broker() {
    let messages = vec![json!({
        "from": "WorkerA",
        "conversation_id": "dm_789",
        "participants": ["broker", "WorkerA"],
        "text": "hello broker",
        "timestamp": "2026-02-23T10:00:00Z",
    })];
    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(&messages, &self_names);

    assert_eq!(threads.len(), 1);
    assert_eq!(
        threads[0].name, "WorkerA",
        "should filter out broker from participants"
    );
}

#[test]
fn build_thread_infos_multiple_independent_dm_conversations() {
    let messages = vec![
        json!({
            "from": "Alice",
            "conversation_id": "dm_aaa",
            "participants": ["Alice", "Bob"],
            "text": "hi Bob",
            "timestamp": "2026-02-23T10:00:00Z",
        }),
        json!({
            "from": "Charlie",
            "conversation_id": "dm_bbb",
            "participants": ["Charlie", "Diana"],
            "text": "hi Diana",
            "timestamp": "2026-02-23T10:01:00Z",
        }),
        json!({
            "from": "broker",
            "conversation_id": "dm_ccc",
            "participants": ["broker", "Eve"],
            "text": "hi Eve",
            "timestamp": "2026-02-23T10:02:00Z",
        }),
    ];
    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(&messages, &self_names);

    assert_eq!(
        threads.len(),
        3,
        "should have three separate DM conversations"
    );

    let thread_aaa = threads.iter().find(|t| t.thread_id == "dm_aaa").unwrap();
    assert_eq!(thread_aaa.name, "Alice ↔ Bob");

    let thread_bbb = threads.iter().find(|t| t.thread_id == "dm_bbb").unwrap();
    assert_eq!(thread_bbb.name, "Charlie ↔ Diana");

    let thread_ccc = threads.iter().find(|t| t.thread_id == "dm_ccc").unwrap();
    assert_eq!(thread_ccc.name, "Eve", "broker filtered from participants");
}

#[test]
fn build_thread_infos_respects_explicit_unread_count() {
    let messages = vec![json!({
        "from": "Planner",
        "target": "broker",
        "text": "status",
        "unread_count": 7,
        "timestamp": "2026-02-23T10:01:00Z",
    })];
    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(&messages, &self_names);

    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].unread_count, 7);
}

#[test]
fn parse_sort_key_normalizes_numeric_seconds_to_millis() {
    assert_eq!(
        parse_sort_key_from_raw_timestamp("1771840800"),
        Some(1_771_840_800_000)
    );
    assert_eq!(
        parse_sort_key_from_raw_timestamp("1771840800000"),
        Some(1_771_840_800_000)
    );
    assert_eq!(
        parse_sort_key_from_raw_timestamp("2026-02-23T10:00:00Z"),
        Some(1_771_840_800_000)
    );
}

#[test]
fn parse_sort_key_handles_edge_inputs() {
    // The seconds/millis pivot: values below 4_102_444_800 (2100-01-01 in
    // seconds) are treated as seconds, values at or above it as millis.
    assert_eq!(
        parse_sort_key_from_raw_timestamp("4102444799"),
        Some(4_102_444_799_000)
    );
    assert_eq!(
        parse_sort_key_from_raw_timestamp("4102444800"),
        Some(4_102_444_800)
    );
    // Negative epochs are still scaled as seconds.
    assert_eq!(parse_sort_key_from_raw_timestamp("-5"), Some(-5_000));
    // RFC3339 with an offset normalizes to UTC millis.
    assert_eq!(
        parse_sort_key_from_raw_timestamp("2026-02-23T12:00:00+02:00"),
        Some(1_771_840_800_000)
    );
    // Whitespace-only and unparseable inputs yield no sort key.
    assert_eq!(parse_sort_key_from_raw_timestamp("   "), None);
    assert_eq!(parse_sort_key_from_raw_timestamp("soon"), None);
    assert_eq!(parse_sort_key_from_raw_timestamp("1.5e9"), None);
}

#[test]
fn typed_thread_message_parses_broker_recorded_shape() {
    let recorded = json!({
        "event_id": "evt_recorded_1",
        "from": "Lead",
        "target": "#general",
        "text": "typed lane",
        "thread_id": null,
        "workspace_id": "ws_1",
        "workspace_alias": "main",
        "timestamp": "2026-02-23T10:00:00Z",
    });
    assert!(
        matches!(
            TypedThreadMessage::parse(&recorded),
            Some(TypedThreadMessage::Recorded(_))
        ),
        "broker-recorded thread history events must parse typed"
    );

    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(std::slice::from_ref(&recorded), &self_names);
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].thread_id, "#general");
    assert_eq!(threads[0].last_message.as_deref(), Some("typed lane"));
    assert_eq!(
        threads[0].last_message_at.as_deref(),
        Some("2026-02-23T10:00:00Z")
    );
}

#[test]
fn typed_thread_message_parses_dm_history_shape() {
    // `relaycast::MessageWithMeta` serialized to JSON with conversation_id
    // and participants injected by `get_all_dms`.
    let dm_history = json!({
        "id": "184467440737095530",
        "agent_name": "WorkerA",
        "agent_id": "147298826957365248",
        "text": "dm history payload",
        "blocks": null,
        "metadata": {},
        "attachments": [],
        "created_at": "2026-02-23T10:05:00Z",
        "reply_count": 0,
        "reactions": [],
        "read_by_count": 0,
        "injection_mode": null,
        "conversation_id": "dm_456",
        "participants": ["WorkerA", "WorkerB"],
    });
    assert!(
        matches!(
            TypedThreadMessage::parse(&dm_history),
            Some(TypedThreadMessage::DmHistory(_))
        ),
        "REST DM history messages must parse typed"
    );

    let self_names = HashSet::from(["broker".to_string()]);
    let threads = build_thread_infos(std::slice::from_ref(&dm_history), &self_names);
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].thread_id, "dm_456");
    assert_eq!(threads[0].name, "WorkerA ↔ WorkerB");
    assert_eq!(
        threads[0].last_message.as_deref(),
        Some("dm history payload")
    );
    assert_eq!(threads[0].unread_count, 1);
}

#[test]
fn typed_and_tolerant_thread_grouping_agree_for_recorded_events() {
    // The typed lane must group a broker-recorded event exactly like the
    // tolerant probing lane groups its untyped equivalent (an event
    // missing `event_id` falls back to field probing).
    let typed_event = json!({
        "event_id": "evt_recorded_2",
        "from": "WorkerA",
        "target": "broker",
        "text": "status update",
        "thread_id": null,
        "timestamp": "2026-02-23T10:00:00Z",
    });
    let untyped_event = json!({
        "from": "WorkerA",
        "target": "broker",
        "text": "status update",
        "timestamp": "2026-02-23T10:00:00Z",
    });
    assert!(TypedThreadMessage::parse(&typed_event).is_some());
    assert!(TypedThreadMessage::parse(&untyped_event).is_none());

    let self_names = HashSet::from(["broker".to_string()]);
    let typed_threads = build_thread_infos(std::slice::from_ref(&typed_event), &self_names);
    let tolerant_threads = build_thread_infos(std::slice::from_ref(&untyped_event), &self_names);
    assert_eq!(typed_threads, tolerant_threads);
}

#[test]
fn build_agent_state_transition_event_has_expected_shape() {
    let payload = build_agent_state_transition_event("worker-a", "spawned", Some("sdk_spawn"));
    assert_eq!(payload["type"], "agent.state");
    assert_eq!(payload["state"], "spawned");
    assert_eq!(payload["agent"]["name"], "worker-a");
    assert_eq!(payload["reason"], "sdk_spawn");
    assert!(payload["timestamp"].as_str().is_some());

    let no_reason = build_agent_state_transition_event("worker-a", "idle", None);
    assert!(no_reason.get("reason").is_none());
}

#[test]
fn preregistration_error_message_dedupes_retry_after_for_rate_limit() {
    let error = RelaycastRegistrationError::RateLimited {
        agent_name: "Foobar".to_string(),
        retry_after_secs: 60,
        detail: "{\"ok\":false}".to_string(),
    };
    let message = format_worker_preregistration_error("Foobar", &error);
    assert_eq!(message.matches("retry after").count(), 1);
}

#[test]
fn preregistration_error_message_does_not_invent_retry_after_for_transport_errors() {
    let error = RelaycastRegistrationError::Transport {
        agent_name: "Foobar".to_string(),
        detail: "timeout".to_string(),
    };
    let message = format_worker_preregistration_error("Foobar", &error);
    assert!(!message.contains("retry after"));
}

#[test]
fn preregistration_fallback_is_limited_to_local_headless_task_exit() {
    let headless = build_http_api_spawn_spec(
        WorkerName::new("worker-a"),
        "opencode".to_string(),
        Some("headless".to_string()),
        None,
        Vec::new(),
        Vec::new(),
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("headless spec");
    assert!(can_spawn_without_preregistration(&headless, true, true));
    assert!(!can_spawn_without_preregistration(&headless, false, true));
    assert!(!can_spawn_without_preregistration(&headless, true, false));

    let endpoint_headless = ResolvedHarnessConfig::Headless(HeadlessHarnessConfig {
        driver: HeadlessHarnessDriver::AppServer,
        protocol: "opencode".to_string(),
        endpoint: "http://127.0.0.1:4096".to_string(),
        session_id: "session-endpoint".to_string(),
        auth: None,
        host: None,
        release: Some(HarnessReleasePolicy::Abort),
        metadata: None,
    });
    let endpoint_spec = build_http_api_spawn_spec(
        WorkerName::from("worker-endpoint"),
        "opencode-server".to_string(),
        Some("headless".to_string()),
        None,
        Vec::new(),
        Vec::new(),
        None,
        None,
        None,
        None,
        None,
        Some(endpoint_headless),
    )
    .expect("endpoint-backed headless spec");
    assert!(!can_spawn_without_preregistration(
        &endpoint_spec,
        true,
        true
    ));

    let pty = build_http_api_spawn_spec(
        WorkerName::new("worker-b"),
        "codex".to_string(),
        Some("pty".to_string()),
        None,
        Vec::new(),
        Vec::new(),
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("pty spec");
    assert!(!can_spawn_without_preregistration(&pty, true, true));
}

/// Exercise the complete `/api/spawn` path around Relaycast registration
/// failure. The real router emits a spawn request while Relaycast stays at a
/// persistent typed 503. Only an explicitly local/headless/task-exit request
/// reaches `WorkerRegistry::spawn`; the PTY request fails closed.
#[tokio::test]
async fn api_spawn_retries_overload_and_only_safe_mode_falls_back() {
    use httpmock::{Method::POST, MockServer};

    let server = MockServer::start();
    let registration = server.mock(|when, then| {
        when.method(POST).path("/v1/agents");
        then.status(503).json_body(json!({
            "ok": false,
            "error": {
                "code": "database_overloaded",
                "message": "The database is temporarily overloaded.",
                "request_id": "req-overload"
            }
        }));
    });

    let (worker_event_tx, _worker_event_rx) = mpsc::channel(16);
    let worker_logs_dir = tempfile::tempdir().expect("worker logs dir");
    let workers = WorkerRegistry::new(
        worker_event_tx,
        Vec::new(),
        worker_logs_dir.path().to_path_buf(),
        Instant::now(),
    );
    let mut fixture =
        worker_event_runtime_fixture_with_relay(workers, HashMap::new(), Some(server.base_url()));
    let (events_tx, _events_rx) = tokio::sync::broadcast::channel(8);
    let router = listen_api_router_with_auth(
        ListenApiConfig {
            tx: fixture.api_tx.clone(),
            events_tx,
            replay_buffer: ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY),
            workspace_key: None,
            relay_base_url: Some(server.base_url()),
            memberships: Vec::new(),
            local_only: false,
            default_workspace_id: Some(WorkspaceId::new("ws_demo")),
            node_id: "node_test".to_string(),
            node_name: "test-node".to_string(),
            node_token: std::sync::Arc::new(std::sync::RwLock::new(None)),
            persist: false,
            node_delivery_probe: std::sync::Arc::new(
                crate::node_delivery_probe::NodeDeliveryProbe::new(),
            ),
        },
        None,
    );
    let spawn_request = |body: Value| {
        Request::builder()
            .method("POST")
            .uri("/api/spawn")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("spawn body")))
            .expect("spawn request")
    };

    let unsafe_response = tokio::spawn(router.clone().oneshot(spawn_request(json!({
        "name": "unsafe-overload-worker",
        "cli": "codex",
        "transport": "pty"
    }))));
    let unsafe_api_request = fixture
        .runtime
        .api_rx
        .recv()
        .await
        .expect("unsafe API request");
    fixture.runtime.handle_api_request(unsafe_api_request).await;

    let unsafe_response = unsafe_response
        .await
        .expect("unsafe router task")
        .expect("unsafe router response");
    assert_eq!(
        unsafe_response.status(),
        axum::http::StatusCode::INTERNAL_SERVER_ERROR
    );
    let unsafe_body = to_bytes(unsafe_response.into_body(), usize::MAX)
        .await
        .expect("unsafe response body");
    let unsafe_json: Value = serde_json::from_slice(&unsafe_body).expect("unsafe JSON");
    let unsafe_error = unsafe_json["error"].as_str().expect("unsafe error");
    assert!(unsafe_error.contains("503"));
    assert!(unsafe_error.contains("database_overloaded"));
    assert!(unsafe_error.contains("attempts: 3"));
    assert!(fixture.runtime.workers.workers.is_empty());

    let safe_response = tokio::spawn(router.oneshot(spawn_request(json!({
        "name": "safe-overload-worker",
        "cli": "codex",
        "transport": "headless",
        "spawnMode": "task_exit",
        "skipRelayPrompt": true,
        "task": "run the local task",
        "harnessConfig": {
            "runtime": "native",
            "command": "cat",
            "sessionId": "session-safe"
        }
    }))));
    let safe_api_request = fixture
        .runtime
        .api_rx
        .recv()
        .await
        .expect("safe API request");
    fixture.runtime.handle_api_request(safe_api_request).await;

    let safe_response = safe_response
        .await
        .expect("safe router task")
        .expect("safe router response");
    assert_eq!(safe_response.status(), axum::http::StatusCode::OK);
    let safe_body = to_bytes(safe_response.into_body(), usize::MAX)
        .await
        .expect("safe response body");
    let safe_json: Value = serde_json::from_slice(&safe_body).expect("safe JSON");
    assert_eq!(safe_json["success"], true);
    assert_eq!(safe_json["runtime"], "headless");
    assert_eq!(safe_json["pre_registered"], false);
    assert_eq!(safe_json["sessionId"], "session-safe");
    assert!(
        safe_json["pid"].as_u64().is_some(),
        "must report the live process PID"
    );
    let warning = safe_json["warning"].as_str().expect("safe warning");
    assert!(warning.contains("503"));
    assert!(warning.contains("database_overloaded"));
    assert!(warning.contains("attempts: 3"));
    assert!(fixture.runtime.workers.has_worker("safe-overload-worker"));
    assert!(
        !fixture
            .runtime
            .workers
            .owned_spawn_generations
            .contains_key(&WorkerName::from("safe-overload-worker")),
        "tokenless fallback must not claim cleanup ownership"
    );
    assert_eq!(
        registration.hits(),
        6,
        "each spawn gets the full bounded retry budget"
    );

    fixture
        .runtime
        .workers
        .release("safe-overload-worker")
        .await
        .expect("clean up local fallback worker");
}

#[test]
fn injection_format_preserved() {
    let rendered = format_injection("alice", "evt_1", "hello", "bob");
    assert!(rendered.contains("<system-reminder>"));
    assert!(rendered.contains("mcp__agent-relay__send_dm"));
    assert!(rendered.contains("Relay message from alice [evt_1]: hello"));
}

#[test]
fn injection_format_includes_channel() {
    let rendered = format_injection("alice", "evt_1", "hello", "#general");
    assert!(rendered.contains("mcp__agent-relay__post_message"));
    assert!(rendered.contains("channel: \"general\""));
    assert!(rendered.contains("Relay message from alice in #general [evt_1]: hello"));
}

#[test]
fn normalize_sender_defaults_to_human_orchestrator() {
    assert_eq!(normalize_sender(None), "human:orchestrator");
    assert_eq!(normalize_sender(Some(String::new())), "human:orchestrator");
    assert_eq!(
        normalize_sender(Some("   ".to_string())),
        "human:orchestrator"
    );
}

#[test]
fn normalize_sender_normalizes_human_prefix() {
    assert_eq!(
        normalize_sender(Some("human:  Dashboard  ".to_string())),
        "human:Dashboard"
    );
}

#[test]
fn normalize_sender_preserves_worker_names() {
    assert_eq!(
        normalize_sender(Some("WorkerOne".to_string())),
        "WorkerOne".to_string()
    );
}

#[test]
fn recipient_reachability_uses_the_same_trimmed_target_as_publication() {
    assert_eq!(
        recipient_name_for_reachability(&MessageTarget::new("  worker-a  "), "sender"),
        Some("worker-a".to_string())
    );
    assert_eq!(
        recipient_name_for_reachability(&MessageTarget::new("  @self  "), "sender"),
        Some("sender".to_string())
    );
    assert_eq!(
        recipient_name_for_reachability(&MessageTarget::new("  #general  "), "sender"),
        None
    );
}

#[test]
fn sender_is_dashboard_label_accepts_legacy_dashboard_senders() {
    assert!(sender_is_dashboard_label("Dashboard", "my-project"));
    assert!(sender_is_dashboard_label("human:Dashboard", "my-project"));
    assert!(sender_is_dashboard_label(
        "human:orchestrator",
        "my-project"
    ));
    assert!(sender_is_dashboard_label("my-project", "my-project"));
    assert!(!sender_is_dashboard_label("Lead", "my-project"));
}

#[test]
fn delivery_retry_interval_uses_default_and_env_override() {
    let _guard = env_test_lock().lock().expect("env test lock");
    std::env::remove_var("AGENT_RELAY_DELIVERY_RETRY_MS");
    assert_eq!(delivery_retry_interval().as_millis(), 1_000);

    std::env::set_var("AGENT_RELAY_DELIVERY_RETRY_MS", "250");
    assert_eq!(delivery_retry_interval().as_millis(), 250);

    std::env::set_var("AGENT_RELAY_DELIVERY_RETRY_MS", "1");
    assert_eq!(delivery_retry_interval().as_millis(), 50);

    std::env::remove_var("AGENT_RELAY_DELIVERY_RETRY_MS");
}

#[test]
fn http_api_timeout_windows_use_default_and_env_override() {
    let _guard = env_test_lock().lock().expect("env test lock");
    std::env::remove_var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS");
    std::env::remove_var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS");
    std::env::remove_var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS");

    assert_eq!(http_api_local_delivery_timeout().as_millis(), 3_000);
    assert_eq!(http_api_relaycast_send_timeout().as_millis(), 20_000);
    assert_eq!(http_api_event_emit_timeout().as_millis(), 200);

    std::env::set_var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS", "10");
    std::env::set_var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS", "100");
    std::env::set_var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS", "1");

    assert_eq!(http_api_local_delivery_timeout().as_millis(), 100);
    assert_eq!(http_api_relaycast_send_timeout().as_millis(), 500);
    assert_eq!(http_api_event_emit_timeout().as_millis(), 25);

    std::env::set_var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS", "1500");
    std::env::set_var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS", "12000");
    std::env::set_var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS", "150");

    assert_eq!(http_api_local_delivery_timeout().as_millis(), 1_500);
    assert_eq!(http_api_relaycast_send_timeout().as_millis(), 12_000);
    assert_eq!(http_api_event_emit_timeout().as_millis(), 150);

    std::env::remove_var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS");
    std::env::remove_var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS");
    std::env::remove_var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS");
}

#[test]
fn drop_pending_for_worker_removes_only_matching_entries() {
    let mut pending: HashMap<DeliveryId, PendingDelivery> = HashMap::new();
    pending.insert(
        DeliveryId::new("del_1"),
        PendingDelivery {
            worker_name: WorkerName::from("A"),
            delivery: RelayDelivery {
                delivery_id: DeliveryId::new("del_1"),
                event_id: EventId::new("evt_1"),
                workspace_id: Some(WorkspaceId::new("ws_test")),
                workspace_alias: Some(WorkspaceAlias::new("test")),
                from: "x".to_string(),
                target: MessageTarget::new("#general"),
                body: "hello".to_string(),
                thread_id: None,
                priority: None,
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 1,
            failed_attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    );
    pending.insert(
        DeliveryId::new("del_2"),
        PendingDelivery {
            worker_name: WorkerName::from("B"),
            delivery: RelayDelivery {
                delivery_id: DeliveryId::new("del_2"),
                event_id: EventId::new("evt_2"),
                workspace_id: Some(WorkspaceId::new("ws_test")),
                workspace_alias: Some(WorkspaceAlias::new("test")),
                from: "y".to_string(),
                target: MessageTarget::new("#general"),
                body: "world".to_string(),
                thread_id: None,
                priority: None,
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 1,
            failed_attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    );

    let dropped = drop_pending_for_worker(&mut pending, "A");
    assert_eq!(dropped, 1);
    assert!(pending.contains_key("del_2"));
    assert!(!pending.contains_key("del_1"));
}

#[tokio::test]
async fn dropped_pending_deliveries_emit_terminal_message_failures() {
    let pending = PendingDelivery {
        worker_name: WorkerName::from("A"),
        delivery: RelayDelivery {
            delivery_id: DeliveryId::new("del_1"),
            event_id: EventId::new("evt_1"),
            workspace_id: Some(WorkspaceId::new("ws_test")),
            workspace_alias: Some(WorkspaceAlias::new("test")),
            from: "Lead".to_string(),
            target: MessageTarget::new("A"),
            body: "hello".to_string(),
            thread_id: None,
            priority: None,
            injection_mode: MessageInjectionMode::Wait,
        },
        attempts: 2,
        failed_attempts: 1,
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: Some("previous blip".to_string()),
        withheld_fleet_ack: None,
        withheld_fleet_ack_floor: None,
        sent_route: None,
    };
    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(4);
    let mut dead_letters = DeadLetterStore::default();

    emit_dropped_delivery_failures(
        &sdk_out_tx,
        &mut dead_letters,
        &[pending],
        "worker_permanently_dead",
    )
    .await
    .expect("dropped delivery failure should emit");

    let frame = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv())
        .await
        .expect("terminal failure should be emitted")
        .expect("sdk_out_tx should remain open");
    assert_eq!(frame.msg_type, "event");
    assert_eq!(frame.payload["kind"], "message_delivery_failed");
    assert_eq!(frame.payload["name"], "A");
    assert_eq!(frame.payload["delivery_id"], "del_1");
    assert_eq!(frame.payload["event_id"], "evt_1");
    assert_eq!(frame.payload["from"], "Lead");
    assert_eq!(frame.payload["to"], "A");
    assert_eq!(frame.payload["attempts"].as_u64(), Some(2));
    assert_eq!(frame.payload["lastError"], "worker_permanently_dead");

    // The terminal failure is followed by the dead_letter_added event so
    // consumers can track the capture, not just the failure.
    let dead_frame = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv())
        .await
        .expect("dead_letter_added should be emitted after the failure")
        .expect("sdk_out_tx should remain open");
    assert_eq!(dead_frame.msg_type, "event");
    assert_eq!(dead_frame.payload["kind"], "dead_letter_added");
    assert_eq!(dead_frame.payload["delivery_id"], "del_1");
    assert_eq!(dead_frame.payload["reason"], "worker_permanently_dead");

    assert_eq!(
        dead_letters.len(),
        1,
        "dropped deliveries are retained in the dead-letter store"
    );
    assert_eq!(
        dead_letters.get("del_1").expect("dead letter by id").reason,
        "worker_permanently_dead"
    );
}

#[test]
fn should_clear_pending_delivery_when_event_id_matches() {
    let pending = PendingDelivery {
        worker_name: WorkerName::from("A"),
        delivery: RelayDelivery {
            delivery_id: DeliveryId::new("del_1"),
            event_id: EventId::new("evt_1"),
            workspace_id: Some(WorkspaceId::new("ws_test")),
            workspace_alias: Some(WorkspaceAlias::new("test")),
            from: "x".to_string(),
            target: MessageTarget::new("#general"),
            body: "hello".to_string(),
            thread_id: None,
            priority: None,
            injection_mode: MessageInjectionMode::Wait,
        },
        attempts: 1,
        failed_attempts: 0,
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: None,
        withheld_fleet_ack: None,
        withheld_fleet_ack_floor: None,
        sent_route: None,
    };

    assert!(should_clear_pending_delivery_for_event(
        Some(&pending),
        Some("evt_1")
    ));
    assert!(!should_clear_pending_delivery_for_event(
        Some(&pending),
        Some("evt_2")
    ));
}

#[test]
fn clear_pending_delivery_returns_none_for_stale_event_id() {
    let mut pending = HashMap::from([(
        DeliveryId::new("del_1"),
        PendingDelivery {
            worker_name: WorkerName::from("A"),
            delivery: RelayDelivery {
                delivery_id: DeliveryId::new("del_1"),
                event_id: EventId::new("evt_current"),
                workspace_id: Some(WorkspaceId::new("ws_test")),
                workspace_alias: Some(WorkspaceAlias::new("test")),
                from: "x".to_string(),
                target: MessageTarget::new("#general"),
                body: "hello".to_string(),
                thread_id: None,
                priority: None,
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 1,
            failed_attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    )]);

    let removed = clear_pending_delivery_if_event_matches(
        &mut pending,
        "del_1",
        Some("evt_stale"),
        "A",
        "delivery_failed",
    );

    assert!(removed.is_none());
    assert!(pending.contains_key("del_1"));
}

#[test]
fn delivery_read_ack_classification_skips_synthetic_event_ids() {
    let cases = [
        ("", Some("blank_event_id")),
        ("   ", Some("blank_event_id")),
        ("http_123", Some("http_api_synthetic_event_id")),
        ("init_123", Some("initial_task_synthetic_event_id")),
        ("cont_load_123", Some("continuity_synthetic_event_id")),
        ("flush_123", Some("manual_flush_synthetic_event_id")),
        ("msg_123", None),
        ("1780911342_317109", None),
    ];

    for (event_id, expected) in cases {
        let event_id = EventId::new(event_id);
        assert_eq!(synthetic_delivery_read_ack_reason(&event_id), expected);
        assert_eq!(
            delivery_read_ack_is_relaycast_message(&event_id),
            expected.is_none()
        );
    }
}

#[test]
fn delivery_read_ack_event_shape_is_stable() {
    let event = BrokerEvent::DeliveryReadAck {
        name: WorkerName::new("Worker1"),
        delivery_id: DeliveryId::new("del_1"),
        event_id: EventId::new("msg_1"),
        status: DeliveryReadAckStatus::SkippedSynthetic,
        reason: Some("initial_task_synthetic_event_id".to_string()),
    };

    let encoded = serde_json::to_value(&event).expect("event serializes");
    assert_eq!(encoded["kind"], "delivery_read_ack");
    assert_eq!(encoded["name"], "Worker1");
    assert_eq!(encoded["delivery_id"], "del_1");
    assert_eq!(encoded["event_id"], "msg_1");
    assert_eq!(encoded["status"], "skipped_synthetic");
    assert_eq!(encoded["reason"], "initial_task_synthetic_event_id");
}

#[tokio::test]
async fn confirmed_delivery_read_ack_marks_relaycast_exactly_once() {
    use httpmock::{Method::POST, MockServer};

    let server = MockServer::start();
    let read_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/v1/messages/msg_1/read")
            .header("authorization", "Bearer at_live_supplied_recipient");
        then.status(200).json_body(json!({
            "ok": true,
            "data": {
                "message_id": "msg_1",
                "agent_id": "agent_supplied_recipient",
                "read_at": "2026-06-08T10:00:00.000Z"
            }
        }));
    });
    let spawn_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/agents");
        then.status(200).json_body(json!({
            "ok": true,
            "data": {
                "id": "agent_fresh_wrong",
                "workspace_id": "ws_fresh_wrong",
                "name": "recipient",
                "status": "online",
                "created_at": "2026-06-08T10:00:00.000Z",
                "token": "at_live_fresh_wrong"
            }
        }));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    seed_supplied_agent_token(&client, "recipient", "at_live_supplied_recipient");
    let mut dedup = DedupCache::new(Duration::from_secs(300), 16);
    let (tx, mut rx) = mpsc::channel(4);
    let mut pending = HashMap::from([(
        DeliveryId::new("del_1"),
        pending_delivery("recipient", "del_1", "msg_1"),
    )]);

    let confirmed = clear_pending_delivery_if_event_matches(
        &mut pending,
        "del_1",
        Some("msg_1"),
        "recipient",
        "delivery_ack",
    )
    .expect("matching delivery_ack confirms the pending delivery");

    mark_delivery_read_ack(
        &client,
        &tx,
        &mut dedup,
        &WorkerName::new("recipient"),
        Some("codex"),
        &confirmed.delivery.delivery_id,
        &confirmed.delivery.event_id,
    );

    let frame = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("delivery_read_ack telemetry should arrive")
        .expect("delivery_read_ack event emitted");
    assert_eq!(frame.msg_type, "event");
    assert_eq!(frame.payload["kind"], "delivery_read_ack");
    assert_eq!(frame.payload["name"], "recipient");
    assert_eq!(frame.payload["delivery_id"], "del_1");
    assert_eq!(frame.payload["event_id"], "msg_1");
    assert_eq!(frame.payload["status"], "marked");
    assert!(frame.payload.get("reason").is_none());
    read_mock.assert_hits(1);
    spawn_mock.assert_hits(0);
}

#[tokio::test]
async fn duplicate_delivery_read_ack_suppresses_repeat_mark_read() {
    use httpmock::{Method::POST, MockServer};

    let server = MockServer::start();
    let read_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/v1/messages/msg_dup/read")
            .header("authorization", "Bearer at_live_recipient_dup");
        then.status(200).json_body(json!({
            "ok": true,
            "data": {
                "message_id": "msg_dup",
                "agent_id": "agent_recipient_dup",
                "read_at": "2026-06-08T10:00:00.000Z"
            }
        }));
    });
    let spawn_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/agents");
        then.status(200).json_body(json!({
            "ok": true,
            "data": {
                "id": "agent_fresh_wrong",
                "workspace_id": "ws_fresh_wrong",
                "name": "recipient",
                "status": "online",
                "created_at": "2026-06-08T10:00:00.000Z",
                "token": "at_live_fresh_wrong"
            }
        }));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    seed_supplied_agent_token(&client, "recipient", "at_live_recipient_dup");
    let mut dedup = DedupCache::new(Duration::from_secs(300), 16);
    let (tx, mut rx) = mpsc::channel(4);

    mark_delivery_read_ack(
        &client,
        &tx,
        &mut dedup,
        &WorkerName::new("recipient"),
        Some("codex"),
        &DeliveryId::new("del_dup_1"),
        &EventId::new("msg_dup"),
    );
    mark_delivery_read_ack(
        &client,
        &tx,
        &mut dedup,
        &WorkerName::new("recipient"),
        Some("codex"),
        &DeliveryId::new("del_dup_2"),
        &EventId::new("msg_dup"),
    );

    let mut statuses = Vec::new();
    for _ in 0..2 {
        let frame = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("delivery_read_ack telemetry should arrive")
            .expect("delivery_read_ack event emitted");
        assert_eq!(frame.payload["kind"], "delivery_read_ack");
        statuses.push(
            frame.payload["status"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        );
    }

    assert!(statuses.iter().any(|status| status == "marked"));
    assert!(statuses
        .iter()
        .any(|status| status == "suppressed_duplicate"));
    read_mock.assert_hits(1);
    spawn_mock.assert_hits(0);
}

#[tokio::test]
async fn stale_delivery_ack_event_id_does_not_mark_read() {
    use httpmock::{Method::POST, MockServer};

    let server = MockServer::start();
    let read_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/messages/msg_current/read");
        then.status(200).json_body(json!({"ok": true, "data": {}}));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    seed_supplied_agent_token(&client, "recipient", "at_live_recipient");
    let mut dedup = DedupCache::new(Duration::from_secs(300), 16);
    let (tx, mut rx) = mpsc::channel(4);
    let mut pending = HashMap::from([(
        DeliveryId::new("del_stale"),
        pending_delivery("recipient", "del_stale", "msg_current"),
    )]);

    let confirmed = clear_pending_delivery_if_event_matches(
        &mut pending,
        "del_stale",
        Some("msg_stale"),
        "recipient",
        "delivery_ack",
    );
    if let Some(confirmed) = confirmed {
        mark_delivery_read_ack(
            &client,
            &tx,
            &mut dedup,
            &WorkerName::new("recipient"),
            Some("codex"),
            &confirmed.delivery.delivery_id,
            &confirmed.delivery.event_id,
        );
    }

    assert!(pending.contains_key("del_stale"));
    read_mock.assert_hits(0);
    assert!(tokio::time::timeout(Duration::from_millis(50), rx.recv())
        .await
        .is_err());
}

#[tokio::test]
async fn synthetic_delivery_read_ack_skips_mark_read() {
    use httpmock::{Method::POST, MockServer};

    let server = MockServer::start();
    let read_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/messages/init_123/read");
        then.status(200).json_body(json!({"ok": true, "data": {}}));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    let mut dedup = DedupCache::new(Duration::from_secs(300), 16);
    let (tx, mut rx) = mpsc::channel(4);

    mark_delivery_read_ack(
        &client,
        &tx,
        &mut dedup,
        &WorkerName::new("recipient"),
        Some("codex"),
        &DeliveryId::new("del_init"),
        &EventId::new("init_123"),
    );
    mark_delivery_read_ack(
        &client,
        &tx,
        &mut dedup,
        &WorkerName::new("recipient"),
        Some("codex"),
        &DeliveryId::new("del_init_duplicate"),
        &EventId::new("init_123"),
    );

    let first = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("synthetic skip telemetry should arrive")
        .expect("delivery_read_ack event emitted");
    assert_eq!(first.payload["kind"], "delivery_read_ack");
    assert_eq!(first.payload["status"], "skipped_synthetic");
    assert_eq!(first.payload["reason"], "initial_task_synthetic_event_id");

    let duplicate = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("duplicate synthetic telemetry should arrive")
        .expect("delivery_read_ack event emitted");
    assert_eq!(duplicate.payload["kind"], "delivery_read_ack");
    assert_eq!(duplicate.payload["status"], "suppressed_duplicate");
    assert_eq!(duplicate.payload["reason"], "duplicate_delivery_read_ack");
    read_mock.assert_hits(0);
}

#[tokio::test]
async fn slow_delivery_read_ack_does_not_block_confirmation_path() {
    use httpmock::{Method::POST, MockServer};

    let server = MockServer::start();
    let read_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/v1/messages/msg_slow/read")
            .header("authorization", "Bearer at_live_slow_recipient");
        then.status(200)
            .delay(Duration::from_millis(200))
            .json_body(json!({
                "ok": true,
                "data": {
                    "message_id": "msg_slow",
                    "agent_id": "agent_slow_recipient",
                    "read_at": "2026-06-08T10:00:00.000Z"
                }
            }));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    seed_supplied_agent_token(&client, "recipient", "at_live_slow_recipient");
    let mut dedup = DedupCache::new(Duration::from_secs(300), 16);
    let (tx, mut rx) = mpsc::channel(4);
    let mut pending = HashMap::from([(
        DeliveryId::new("del_slow"),
        pending_delivery("recipient", "del_slow", "msg_slow"),
    )]);

    let confirmed = clear_pending_delivery_if_event_matches(
        &mut pending,
        "del_slow",
        Some("msg_slow"),
        "recipient",
        "delivery_ack",
    )
    .expect("matching delivery_ack confirms the pending delivery");
    send_broker_event(
        &tx,
        BrokerEvent::MessageDeliveryConfirmed {
            name: WorkerName::new("recipient"),
            delivery_id: confirmed.delivery.delivery_id.clone(),
            event_id: confirmed.delivery.event_id.clone(),
            from: confirmed.delivery.from.clone(),
            to: confirmed.delivery.target.clone(),
        },
    )
    .await
    .expect("confirmation event should enqueue before read-ack scheduling");

    let start = Instant::now();
    mark_delivery_read_ack_with_timeout(
        &client,
        &tx,
        &mut dedup,
        &WorkerName::new("recipient"),
        Some("codex"),
        &confirmed.delivery.delivery_id,
        &confirmed.delivery.event_id,
        Duration::from_millis(20),
    );
    assert!(
        start.elapsed() < Duration::from_millis(50),
        "read-ack scheduling must not wait for slow Relaycast mark_read"
    );

    let confirmation = tokio::time::timeout(Duration::from_millis(50), rx.recv())
        .await
        .expect("delivery confirmation must not wait on mark_read")
        .expect("confirmation event emitted");
    assert_eq!(confirmation.payload["kind"], "message_delivery_confirmed");
    assert_eq!(confirmation.payload["delivery_id"], "del_slow");

    let read_ack = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("read-ack failure telemetry should arrive after timeout")
        .expect("delivery_read_ack event emitted");
    assert_eq!(read_ack.payload["kind"], "delivery_read_ack");
    assert_eq!(read_ack.payload["status"], "failed");
    assert!(read_ack.payload["reason"]
        .as_str()
        .unwrap_or_default()
        .contains("timed out"));
    read_mock.assert_hits(1);
}

#[test]
fn should_clear_pending_delivery_without_event_id_for_compatibility() {
    let pending = PendingDelivery {
        worker_name: WorkerName::from("A"),
        delivery: RelayDelivery {
            delivery_id: DeliveryId::new("del_1"),
            event_id: EventId::new("evt_1"),
            workspace_id: Some(WorkspaceId::new("ws_test")),
            workspace_alias: Some(WorkspaceAlias::new("test")),
            from: "x".to_string(),
            target: MessageTarget::new("#general"),
            body: "hello".to_string(),
            thread_id: None,
            priority: None,
            injection_mode: MessageInjectionMode::Wait,
        },
        attempts: 1,
        failed_attempts: 0,
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: None,
        withheld_fleet_ack: None,
        withheld_fleet_ack_floor: None,
        sent_route: None,
    };

    assert!(should_clear_pending_delivery_for_event(
        Some(&pending),
        None
    ));
    assert!(should_clear_pending_delivery_for_event(
        Some(&pending),
        Some("")
    ));
    assert!(should_clear_pending_delivery_for_event(None, Some("evt_1")));
}

// ==================== strip_ansi tests ====================

#[test]
fn strip_ansi_removes_csi_sequences() {
    assert_eq!(strip_ansi("\x1b[32mHello\x1b[0m"), "Hello");
    assert_eq!(strip_ansi("\x1b[1;31mred bold\x1b[0m"), "red bold");
}

#[test]
fn strip_ansi_removes_osc_sequences() {
    assert_eq!(strip_ansi("\x1b]0;title\x07rest"), "rest");
    assert_eq!(strip_ansi("\x1b]0;title\x1b\\rest"), "rest");
}

#[test]
fn strip_ansi_preserves_plain_text() {
    assert_eq!(strip_ansi("Hello world"), "Hello world");
    assert_eq!(strip_ansi(""), "");
}

#[test]
fn strip_ansi_handles_mixed_content() {
    let input = "\x1b[33m⚠️  bypass\x1b[0m permissions mode\n\x1b[1m(yes/no)\x1b[0m";
    let clean = strip_ansi(input);
    assert!(clean.contains("bypass"));
    assert!(clean.contains("(yes/no)"));
    assert!(!clean.contains("\x1b"));
}

#[test]
fn strip_ansi_handles_cursor_forward_sequences() {
    // Claude Code uses \x1b[1C (cursor forward) instead of spaces
    // These should be replaced with spaces so echo detection works
    let input = "\x1b[1CYes,\x1b[1CI\x1b[1Caccept";
    let clean = strip_ansi(input);
    assert_eq!(clean, " Yes, I accept");
}

// ==================== floor_char_boundary tests ====================

#[test]
fn floor_char_boundary_at_valid_positions() {
    let s = "Hello 世界";
    assert_eq!(floor_char_boundary(s, 0), 0);
    assert_eq!(floor_char_boundary(s, 6), 6);
    assert_eq!(floor_char_boundary(s, 9), 9);
}

#[test]
fn floor_char_boundary_mid_multibyte() {
    let s = "Hello 世界";
    assert_eq!(floor_char_boundary(s, 7), 6);
    assert_eq!(floor_char_boundary(s, 8), 6);
}

#[test]
fn floor_char_boundary_past_end() {
    let s = "Hello 世界";
    assert_eq!(floor_char_boundary(s, 100), s.len());
}

// ==================== detect_bypass_permissions_prompt tests ====================

#[test]
fn bypass_perms_yes_no_prompt() {
    let output = "⚠️  Bypassing all permission checks.\nDo you want to proceed? (yes/no)";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(has_ref);
    assert!(has_confirm);
}

#[test]
fn bypass_perms_dangerously_with_yn() {
    let output = "Running with --dangerously-skip-permissions\nAccept the risks? (y/n)";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(has_ref);
    assert!(has_confirm);
}

#[test]
fn bypass_perms_accept_risk_variant() {
    let output = "bypass permissions mode enabled\nDo you accept the risk of running in this mode?";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(has_ref);
    assert!(has_confirm);
}

#[test]
fn bypass_perms_no_match_normal_output() {
    let output = "I'll help you fix that bug. Let me read the file first.";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(!has_ref);
    assert!(!has_confirm);
}

#[test]
fn bypass_perms_no_false_positive_permission_without_bypass() {
    let output = "File permission denied. (yes/no)";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(!has_ref, "permission without bypass should not match");
    assert!(has_confirm, "yes/no detected but insufficient alone");
}

#[test]
fn bypass_perms_no_false_positive_status_bar() {
    let output = "-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(has_ref, "status bar has bypass+permissions");
    assert!(!has_confirm, "but no confirmation prompt");
}

#[test]
fn bypass_perms_selection_menu_format() {
    let output = "WARNING: ClaudeCoderunninginBypassPermissionsmode\n\
                       Byproceeding,youacceptallresponsibility\n\
                       No,exit\nYes,Iaccept\nEntertoconfirm";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(has_ref);
    assert!(has_confirm);
    assert!(is_bypass_selection_menu(output));
}

#[test]
fn bypass_perms_selection_menu_with_spaces() {
    let output = "WARNING: Claude Code running in Bypass Permissions mode\n\
                       1. No, exit\n2. Yes, I accept\nEnter to confirm";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(has_ref && has_confirm);
    assert!(is_bypass_selection_menu(output));
}

#[test]
fn bypass_perms_legacy_not_selection_menu() {
    let output = "bypass permissions mode\nProceed? (yes/no)";
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
    assert!(has_ref && has_confirm, "legacy should still detect");
    assert!(
        !is_bypass_selection_menu(output),
        "legacy should NOT be selection menu"
    );
}

#[test]
fn bypass_perms_with_raw_ansi() {
    let raw = "\x1b[33m⚠️  bypass permissions\x1b[0m mode\nProceed? \x1b[1m(yes/no)\x1b[0m";
    let clean = strip_ansi(raw);
    let (has_ref, has_confirm) = detect_bypass_permissions_prompt(&clean);
    assert!(has_ref && has_confirm);
}

// ==================== detect_claude_trust_prompt tests ====================

#[test]
fn claude_trust_prompt_full_match() {
    let output = "take a moment to review what's in this folder first.\n\
                       Claude Code'll be able to read, edit, and execute files here.\n\
                       Security guide\n\
                       ❯ 1. Yes, I trust this folder\n\
                         2. No, exit\n\
                       Enter to confirm · Esc to cancel";
    let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
    assert!(has_trust_ref);
    assert!(has_confirmation);
}

#[test]
fn claude_trust_prompt_stripped_spaces() {
    let output = "Yes,Itrustthisfolder\nNo,exit";
    let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
    assert!(has_trust_ref);
    assert!(has_confirmation);
}

#[test]
fn claude_trust_prompt_no_match_normal_output() {
    let output = "I'll help you fix that bug. Let me read the file first.";
    let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
    assert!(!has_trust_ref);
    assert!(!has_confirmation);
}

#[test]
fn claude_trust_prompt_partial_no_exit() {
    let output = "Yes, I trust this folder";
    let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
    assert!(has_trust_ref);
    assert!(!has_confirmation, "should not match without exit option");
}

#[test]
fn claude_trust_prompt_with_ansi() {
    let raw = "\x1b[1m❯ 1. Yes, I trust this folder\x1b[0m\n  2. No, exit";
    let clean = strip_ansi(raw);
    let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(&clean);
    assert!(has_trust_ref && has_confirmation);
}

// ==================== is_in_editor_mode tests ====================

#[test]
fn editor_mode_vim_insert() {
    assert!(is_in_editor_mode("Some text\n-- INSERT --\n"));
    assert!(is_in_editor_mode("Some text\n-- INSERT --"));
}

#[test]
fn editor_mode_claude_cli_not_vim() {
    let output = "-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)";
    assert!(!is_in_editor_mode(output));
}

#[test]
fn editor_mode_nano() {
    let output = "  GNU nano 5.8\nFile: test.txt\n^G Get Help  ^O Write Out";
    assert!(is_in_editor_mode(output));
}

#[test]
fn editor_mode_less_pager() {
    assert!(is_in_editor_mode("some content\n(END)"));
    assert!(is_in_editor_mode("some content\n--More--"));
}

#[test]
fn editor_mode_normal_output() {
    assert!(!is_in_editor_mode(
        "I'll help you with that task. Let me search."
    ));
    assert!(!is_in_editor_mode("$ ls -la\ntotal 0\n$ "));
}

#[test]
fn editor_mode_with_ansi() {
    let output = "\x1b[32mSome text\x1b[0m\n-- INSERT --\n";
    assert!(is_in_editor_mode(output));
}

#[test]
fn editor_mode_vim_visual_modes() {
    assert!(is_in_editor_mode("text\n-- VISUAL --\n"));
    assert!(is_in_editor_mode("text\n-- VISUAL LINE --\n"));
    assert!(is_in_editor_mode("text\n-- VISUAL BLOCK --\n"));
    assert!(is_in_editor_mode("text\n-- REPLACE --\n"));
}

#[test]
fn editor_mode_claude_normal_not_vim() {
    assert!(!is_in_editor_mode("-- NORMAL -- ► some Claude UI text"));
    assert!(!is_in_editor_mode("-- VISUAL -- ▶ Claude UI"));
}

#[test]
fn auto_suggestion_detects_cursor_plus_dim_pattern() {
    assert!(is_auto_suggestion(
        "\x1b[7mW\x1b[27m\x1b[2mhat's the task?\x1b[22m"
    ));
}

#[test]
fn auto_suggestion_detects_send_hint() {
    assert!(is_auto_suggestion("                     ↵ send"));
}

#[test]
fn auto_suggestion_ignores_normal_output() {
    assert!(!is_auto_suggestion("Relay message from Alice [abc]: hello"));
    assert!(!is_auto_suggestion("Running tests..."));
    assert!(!is_auto_suggestion("> \x1b[7m \x1b[27m"));
}

#[test]
fn extract_mcp_ids_from_tool_response() {
    let output = r#"  ⎿  {
       "id": "147310274064424960",
       "conversation_id": "147310245874507776",
       "from": "agent-a",
       "text": "hello"
     }"#;
    let ids = extract_mcp_message_ids(output);
    // Only extracts "id" keys, not "conversation_id"
    assert_eq!(ids, vec!["147310274064424960"]);
}

#[test]
fn extract_mcp_ids_ignores_short_ids() {
    let output = r#""id": "123""#;
    assert!(extract_mcp_message_ids(output).is_empty());
}

#[test]
fn extract_mcp_ids_ignores_non_numeric() {
    let output = r#""id": "msg_abc123def456ghi""#;
    assert!(extract_mcp_message_ids(output).is_empty());
}

#[test]
fn extract_mcp_ids_handles_no_ids() {
    assert!(extract_mcp_message_ids("normal output with no JSON").is_empty());
    assert!(extract_mcp_message_ids("").is_empty());
}

// ==================== bypass flag selection logic tests ====================
// Tests for the bypass flag logic used in WorkerRegistry::spawn().
// The logic is: claude/claude:* → --dangerously-skip-permissions, codex → --dangerously-bypass-approvals-and-sandbox

fn compute_bypass_flag(cli: &str, existing_args: &[String]) -> Option<&'static str> {
    let cli_lower = cli.to_lowercase();
    if (cli_lower == "claude" || cli_lower.starts_with("claude:"))
        && !existing_args
            .iter()
            .any(|a| a.contains("dangerously-skip-permissions"))
    {
        Some("--dangerously-skip-permissions")
    } else if cli_lower == "codex"
        && !existing_args
            .iter()
            .any(|a| a.contains("dangerously-bypass") || a.contains("full-auto"))
    {
        Some("--dangerously-bypass-approvals-and-sandbox")
    } else if cli_lower == "gemini" && !existing_args.iter().any(|a| a == "--yolo" || a == "-y") {
        Some("--yolo")
    } else {
        None
    }
}

#[test]
fn bypass_flag_claude_gets_skip_permissions() {
    assert_eq!(
        compute_bypass_flag("claude", &[]),
        Some("--dangerously-skip-permissions")
    );
}

#[test]
fn bypass_flag_claude_variant_gets_skip_permissions() {
    assert_eq!(
        compute_bypass_flag("claude:latest", &[]),
        Some("--dangerously-skip-permissions")
    );
    assert_eq!(
        compute_bypass_flag("Claude", &[]),
        Some("--dangerously-skip-permissions")
    );
    assert_eq!(
        compute_bypass_flag("CLAUDE:v2", &[]),
        Some("--dangerously-skip-permissions")
    );
}

#[test]
fn bypass_flag_codex_gets_dangerously_bypass() {
    assert_eq!(
        compute_bypass_flag("codex", &[]),
        Some("--dangerously-bypass-approvals-and-sandbox")
    );
}

#[test]
fn bypass_flag_gemini_gets_yolo() {
    assert_eq!(compute_bypass_flag("gemini", &[]), Some("--yolo"));
}

#[test]
fn bypass_flag_gemini_dedup_when_yolo_present() {
    let args = vec!["--yolo".to_string()];
    assert_eq!(
        compute_bypass_flag("gemini", &args),
        None,
        "should not duplicate --yolo flag"
    );
}

#[test]
fn bypass_flag_gemini_dedup_when_y_present() {
    let args = vec!["-y".to_string()];
    assert_eq!(
        compute_bypass_flag("gemini", &args),
        None,
        "should not duplicate when -y shorthand present"
    );
}

#[test]
fn bypass_flag_aider_gets_none() {
    assert_eq!(compute_bypass_flag("aider", &[]), None);
}

#[test]
fn bypass_flag_goose_gets_none() {
    assert_eq!(compute_bypass_flag("goose", &[]), None);
}

#[test]
fn bypass_flag_unknown_cli_gets_none() {
    assert_eq!(compute_bypass_flag("mystery-cli", &[]), None);
}

#[test]
fn bypass_flag_claude_dedup_when_already_present() {
    let args = vec!["--dangerously-skip-permissions".to_string()];
    assert_eq!(
        compute_bypass_flag("claude", &args),
        None,
        "should not duplicate flag"
    );
}

#[test]
fn bypass_flag_codex_dedup_when_already_present() {
    let args = vec!["--dangerously-bypass-approvals-and-sandbox".to_string()];
    assert_eq!(
        compute_bypass_flag("codex", &args),
        None,
        "should not duplicate flag"
    );
}

#[test]
fn bypass_flag_codex_dedup_when_full_auto_present() {
    let args = vec!["--full-auto".to_string()];
    assert_eq!(
        compute_bypass_flag("codex", &args),
        None,
        "should not add bypass when --full-auto already present"
    );
}

#[test]
fn bypass_flag_claude_dedup_partial_match() {
    // If someone passes a different arg containing the substring, still dedup
    let args = vec!["--my-dangerously-skip-permissions-flag".to_string()];
    assert_eq!(
        compute_bypass_flag("claude", &args),
        None,
        "substring match should prevent duplication"
    );
}

#[test]
fn bypass_flag_codex_with_other_args() {
    let args = vec!["--model".to_string(), "gpt-4".to_string()];
    assert_eq!(
        compute_bypass_flag("codex", &args),
        Some("--dangerously-bypass-approvals-and-sandbox"),
        "unrelated args should not prevent bypass flag"
    );
}

// ==================== is_pid_alive ====================

#[test]
fn is_pid_alive_returns_true_for_self() {
    let pid = std::process::id();
    assert!(
        crate::broker::is_pid_alive(pid),
        "current process PID should be alive"
    );
}

#[test]
fn is_pid_alive_returns_false_for_dead_pid() {
    // Spawn a short-lived child, wait for it to exit, then verify it's dead
    let child = std::process::Command::new("true")
        .spawn()
        .expect("failed to spawn 'true'");
    let pid = child.id();
    let mut child = child;
    child.wait().expect("failed to wait on child");
    // After the child exits, its PID should not be alive
    // (the PID may be recycled, but on macOS/Linux it won't be immediately)
    assert!(
        !crate::broker::is_pid_alive(pid),
        "exited child PID should be dead"
    );
}

#[test]
fn is_pid_alive_returns_false_for_bogus_pid() {
    // PID 0 is the kernel scheduler — kill(0, 0) signals the entire process group,
    // not a real target. Use a very high PID that almost certainly doesn't exist.
    // On macOS pid_max is ~99999; on Linux it's typically 32768 or 4194304.
    // 4_000_000 is unlikely to be in use.
    assert!(
        !crate::broker::is_pid_alive(4_000_000),
        "bogus PID 4_000_000 should not be alive (ESRCH)"
    );
}

#[test]
fn is_pid_alive_eperm_means_alive() {
    // PID 1 (launchd/init) is owned by root. When run as a normal user,
    // kill(1, 0) returns EPERM — the process exists but we can't signal it.
    // This is exactly the EPERM case our fix handles.
    // Skip if running as root (e.g., in some CI containers) since root can
    // signal any process and would get rc=0 instead of EPERM.
    if unsafe { nix::libc::getuid() } == 0 {
        eprintln!("skipping EPERM test: running as root");
        return;
    }
    assert!(
        crate::broker::is_pid_alive(1),
        "PID 1 (init/launchd) should report alive via EPERM"
    );
}

// ==================== write_pid_file ====================

// ==================== continuity_dir ====================

#[test]
fn continuity_dir_derives_correct_path_from_state_json() {
    let state_path = std::path::Path::new("/project/.agentworkforce/relay/state.json");
    let result = continuity_dir(state_path);
    assert_eq!(
        result,
        std::path::PathBuf::from("/project/.agentworkforce/relay/continuity")
    );
}

#[test]
fn continuity_dir_works_with_nested_project_path() {
    let state_path =
        std::path::Path::new("/home/user/projects/my-app/.agentworkforce/relay/state.json");
    let result = continuity_dir(state_path);
    assert_eq!(
        result,
        std::path::PathBuf::from("/home/user/projects/my-app/.agentworkforce/relay/continuity")
    );
}

#[test]
fn continuity_dir_preserves_relative_paths() {
    let state_path = std::path::Path::new(".agentworkforce/relay/state.json");
    let result = continuity_dir(state_path);
    assert_eq!(
        result,
        std::path::PathBuf::from(".agentworkforce/relay/continuity")
    );
}

#[test]
fn ephemeral_paths_are_unique_per_broker_instance() {
    let cwd = PathBuf::from("/tmp/agent-relay-test-project");
    let first = ensure_ephemeral_paths(&cwd, "test broker").expect("first ephemeral paths");
    let second = ensure_ephemeral_paths(&cwd, "test broker").expect("second ephemeral paths");

    assert_ne!(first.state, second.state);
    assert_ne!(first.pending, second.pending);
    assert!(first.state.parent().unwrap().exists());
    assert!(second.state.parent().unwrap().exists());
}

#[test]
fn http_api_spawn_spec_defaults_to_pty_runtime() {
    let spec = build_http_api_spawn_spec(
        WorkerName::from("worker-a"),
        "codex".to_string(),
        None,
        Some("o3".to_string()),
        vec!["--fast".to_string()],
        vec![ChannelName::from("general")],
        Some("/tmp/project".to_string()),
        Some("core".to_string()),
        Some(WorkerName::from("Lead")),
        Some("subagent".to_string()),
        None,
        None,
    )
    .expect("spec should build");

    assert!(matches!(spec.runtime, AgentRuntime::Pty));
    assert!(spec.provider.is_none());
    assert_eq!(spec.cli.as_deref(), Some("codex"));
    assert_eq!(spec.model.as_deref(), Some("o3"));
}

#[test]
fn http_api_spawn_spec_uses_headless_runtime_for_supported_providers() {
    let spec = build_http_api_spawn_spec(
        WorkerName::from("worker-a"),
        "opencode".to_string(),
        Some("headless".to_string()),
        Some("ignored".to_string()),
        vec![],
        vec![ChannelName::from("general")],
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("headless spec should build");

    assert!(matches!(spec.runtime, AgentRuntime::Headless));
    assert!(matches!(
        spec.provider,
        Some(ProtocolHeadlessProvider::Opencode)
    ));
    assert!(spec.cli.is_none());
    assert_eq!(spec.model.as_deref(), Some("ignored"));
}

#[test]
fn http_api_spawn_spec_uses_headless_runtime_for_app_server_harness_config() {
    let harness_config = ResolvedHarnessConfig::Headless(HeadlessHarnessConfig {
        driver: HeadlessHarnessDriver::AppServer,
        protocol: "opencode".to_string(),
        endpoint: "http://127.0.0.1:4096".to_string(),
        session_id: "ses_123".to_string(),
        auth: None,
        host: None,
        release: Some(HarnessReleasePolicy::Abort),
        metadata: None,
    });

    let spec = build_http_api_spawn_spec(
        WorkerName::from("worker-a"),
        "opencode-server".to_string(),
        None,
        None,
        vec![],
        vec![ChannelName::from("general")],
        None,
        None,
        None,
        None,
        None,
        Some(harness_config),
    )
    .expect("headless app-server harness spec should build");

    assert!(matches!(spec.runtime, AgentRuntime::Headless));
    assert!(spec.provider.is_none());
    assert_eq!(spec.cli.as_deref(), Some("opencode-server"));
    assert_eq!(spec.session_id.as_deref(), Some("ses_123"));
    assert!(matches!(
        spec.harness_config,
        Some(ResolvedHarnessConfig::Headless(_))
    ));
}

#[test]
fn http_api_spawn_spec_uses_native_harness_command_without_provider_allowlist() {
    let harness_config = ResolvedHarnessConfig::Native(NativeHarnessConfig {
        command: "/usr/bin/node".to_string(),
        args: vec!["sidecar.js".to_string()],
        cwd: Some("/tmp/workspace".to_string()),
        env: None,
        session_id: "native_123".to_string(),
        metadata: None,
    });

    let spec = build_http_api_spawn_spec(
        WorkerName::from("worker-a"),
        "codex".to_string(),
        Some("headless".to_string()),
        None,
        vec![],
        vec![ChannelName::from("general")],
        None,
        None,
        None,
        None,
        None,
        Some(harness_config),
    )
    .expect("native harness config should supply its own command");

    assert!(matches!(spec.runtime, AgentRuntime::Headless));
    assert!(spec.provider.is_none());
    assert_eq!(spec.cli.as_deref(), Some("codex"));
    assert_eq!(spec.session_id.as_deref(), Some("native_123"));
    assert!(matches!(
        spec.harness_config,
        Some(ResolvedHarnessConfig::Native(_))
    ));
}

#[test]
fn http_api_spawn_spec_rejects_unknown_headless_provider_without_harness_config() {
    let error = build_http_api_spawn_spec(
        WorkerName::from("worker-a"),
        "opencode-server".to_string(),
        Some("headless".to_string()),
        None,
        vec![],
        vec![ChannelName::from("general")],
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect_err("custom headless provider without harness config should fail");

    assert!(
        error
            .to_string()
            .contains("does not support headless transport"),
        "unexpected error: {error}"
    );
}

#[test]
fn headless_provider_command_claude_places_flags_before_task() {
    let (bin, args) = super::headless_provider_command(
        &ProtocolHeadlessProvider::Claude,
        "hello world",
        &[
            "--mcp-config".to_string(),
            "{\"mcpServers\":{}}".to_string(),
        ],
    );

    assert_eq!(bin, "claude");
    assert_eq!(args.last().map(String::as_str), Some("hello world"));
    let mcp_pos = args.iter().position(|a| a == "--mcp-config").unwrap();
    let task_pos = args.iter().position(|a| a == "hello world").unwrap();
    assert!(mcp_pos < task_pos, "--mcp-config must precede task");
}

#[test]
fn headless_provider_command_opencode_places_flags_before_task() {
    let (bin, args) = super::headless_provider_command(
        &ProtocolHeadlessProvider::Opencode,
        "hello world",
        &["--agent".to_string(), "agent-relay".to_string()],
    );

    assert_eq!(bin, "opencode");
    assert_eq!(args.first().map(String::as_str), Some("run"));
    assert_eq!(args.last().map(String::as_str), Some("hello world"));
    let agent_pos = args.iter().position(|a| a == "--agent").unwrap();
    let task_pos = args.iter().position(|a| a == "hello world").unwrap();
    assert!(agent_pos < task_pos, "--agent must precede task");
}

#[test]
fn http_api_spawn_spec_rejects_unknown_headless_providers() {
    let error = build_http_api_spawn_spec(
        WorkerName::from("worker-a"),
        "codex".to_string(),
        Some("headless".to_string()),
        None,
        vec![],
        vec![ChannelName::from("general")],
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect_err("unsupported headless provider should fail");

    assert!(
        error
            .to_string()
            .contains("does not support headless transport"),
        "unexpected error: {error}"
    );
}

// ==================== model flag injection tests ====================
// Tests for the --model flag injection logic used in WorkerRegistry::spawn().
// When spec.model is set and non-empty, the broker should inject --model <value>
// into the spawned CLI's argv, unless the user already specified --model.

/// Mirror of the model flag logic in WorkerRegistry::spawn().
fn compute_model_flag(model: Option<&str>, existing_args: &[String]) -> Option<String> {
    model.and_then(|m| {
        if m.is_empty()
            || existing_args
                .iter()
                .any(|a| a == "--model" || a.starts_with("--model=") || a == "-m")
        {
            None
        } else {
            Some(m.to_string())
        }
    })
}

#[test]
fn model_flag_injected_when_present() {
    assert_eq!(
        compute_model_flag(Some("haiku"), &[]),
        Some("haiku".to_string()),
        "model should be injected when set and args are empty"
    );
}

#[test]
fn model_flag_not_injected_when_none() {
    assert_eq!(
        compute_model_flag(None, &[]),
        None,
        "model should not be injected when not set"
    );
}

#[test]
fn model_flag_not_injected_when_empty() {
    assert_eq!(
        compute_model_flag(Some(""), &[]),
        None,
        "model should not be injected when empty string"
    );
}

#[test]
fn model_flag_not_injected_when_already_in_args() {
    let args = vec!["--model".to_string(), "opus".to_string()];
    assert_eq!(
        compute_model_flag(Some("haiku"), &args),
        None,
        "model should not be injected when --model already in args"
    );
}

#[test]
fn model_flag_not_injected_when_short_flag_in_args() {
    let args = vec!["-m".to_string(), "opus".to_string()];
    assert_eq!(
        compute_model_flag(Some("haiku"), &args),
        None,
        "model should not be injected when -m already in args"
    );
}

#[test]
fn model_flag_not_injected_when_equals_format_in_args() {
    let args = vec!["--model=opus".to_string()];
    assert_eq!(
        compute_model_flag(Some("haiku"), &args),
        None,
        "model should not be injected when --model=value already in args"
    );
}

#[test]
fn model_flag_injected_with_other_args() {
    let args = vec!["--verbose".to_string()];
    assert_eq!(
        compute_model_flag(Some("gpt-4o"), &args),
        Some("gpt-4o".to_string()),
        "model should be injected when other unrelated args exist"
    );
}

// ---------------------------------------------------------------------------
// resolve_workspace / observer-token scope selection
//
// Exercises the workspace-resolution precedence shared by `/api/send` and
// `/api/observer-token` (see `resolve_workspace` in `runtime/api.rs`), and
// the fixed read-only scope set minted for `/api/observer-token` — the
// endpoint that lets Pear's "Join as observer" link stop embedding the raw
// `rk_live_...` workspace key (see `default_observer_token_scopes`).
// ---------------------------------------------------------------------------

fn test_relay_workspace(workspace_id: &str, workspace_alias: Option<&str>) -> RelayWorkspace {
    test_relay_workspace_with_base_url(workspace_id, workspace_alias, None)
}

fn test_relay_workspace_with_base_url(
    workspace_id: &str,
    workspace_alias: Option<&str>,
    relay_base_url: Option<&str>,
) -> RelayWorkspace {
    let (ws_control_tx, _ws_control_rx) = mpsc::channel::<WsControl>(1);
    RelayWorkspace {
        workspace_id: WorkspaceId::from(workspace_id.to_string()),
        workspace_alias: workspace_alias.map(|alias| WorkspaceAlias::from(alias.to_string())),
        relay_workspace_key: "rk_live_test".to_string(),
        self_name: "broker".to_string(),
        self_agent_id: AgentId::from("agent_broker".to_string()),
        self_names: HashSet::from(["broker".to_string()]),
        self_agent_ids: HashSet::from([AgentId::from("agent_broker".to_string())]),
        http_client: RelaycastHttpClient::new(
            relay_base_url.map(ToOwned::to_owned),
            "rk_live_test",
            "broker",
            "codex",
        ),
        ws_control_tx,
    }
}

fn test_workspace_lookup(workspaces: &[RelayWorkspace]) -> HashMap<WorkspaceId, RelayWorkspace> {
    workspaces
        .iter()
        .map(|workspace| (workspace.workspace_id.clone(), workspace.clone()))
        .collect()
}

#[test]
fn resolve_workspace_picks_the_sole_attached_workspace_by_default() {
    let workspaces = vec![test_relay_workspace("ws_1", Some("main"))];
    let lookup = test_workspace_lookup(&workspaces);

    let resolved = resolve_workspace(None, None, &workspaces, &lookup, None)
        .expect("single attached workspace should resolve without a selector");
    assert_eq!(resolved.workspace_id, WorkspaceId::from("ws_1".to_string()));
}

#[test]
fn resolve_workspace_matches_explicit_workspace_id() {
    let workspaces = vec![
        test_relay_workspace("ws_1", Some("main")),
        test_relay_workspace("ws_2", Some("secondary")),
    ];
    let lookup = test_workspace_lookup(&workspaces);

    let resolved = resolve_workspace(Some("ws_2"), None, &workspaces, &lookup, None)
        .expect("explicit workspace_id should resolve");
    assert_eq!(resolved.workspace_id, WorkspaceId::from("ws_2".to_string()));
}

#[test]
fn resolve_workspace_matches_alias_case_insensitively() {
    let workspaces = vec![
        test_relay_workspace("ws_1", Some("Main")),
        test_relay_workspace("ws_2", Some("Secondary")),
    ];
    let lookup = test_workspace_lookup(&workspaces);

    let resolved = resolve_workspace(None, Some("secondary"), &workspaces, &lookup, None)
        .expect("workspace_alias lookup should be case-insensitive");
    assert_eq!(resolved.workspace_id, WorkspaceId::from("ws_2".to_string()));
}

#[test]
fn resolve_workspace_falls_back_to_configured_default() {
    let workspaces = vec![
        test_relay_workspace("ws_1", Some("main")),
        test_relay_workspace("ws_2", Some("secondary")),
    ];
    let lookup = test_workspace_lookup(&workspaces);

    let resolved = resolve_workspace(None, None, &workspaces, &lookup, Some("ws_2"))
        .expect("default_workspace_id should resolve when no explicit selector is given");
    assert_eq!(resolved.workspace_id, WorkspaceId::from("ws_2".to_string()));
}

#[test]
fn resolve_workspace_is_ambiguous_with_multiple_workspaces_and_no_default() {
    let workspaces = vec![
        test_relay_workspace("ws_1", Some("main")),
        test_relay_workspace("ws_2", Some("secondary")),
    ];
    let lookup = test_workspace_lookup(&workspaces);

    // `RelayWorkspace` doesn't implement `Debug` (it embeds SDK client
    // handles), so assert via `match` instead of `expect_err`/`unwrap_err`.
    match resolve_workspace(None, None, &workspaces, &lookup, None) {
        Err(error) => assert!(
            error.starts_with("ambiguous_workspace:"),
            "unexpected error: {error}"
        ),
        Ok(_) => panic!("multiple attached workspaces with no selector should be ambiguous"),
    }
}

#[test]
fn resolve_workspace_reports_not_found_for_unknown_id() {
    let workspaces = vec![test_relay_workspace("ws_1", Some("main"))];
    let lookup = test_workspace_lookup(&workspaces);

    match resolve_workspace(Some("ws_missing"), None, &workspaces, &lookup, None) {
        Err(error) => assert!(
            error.starts_with("workspace_not_found:"),
            "unexpected error: {error}"
        ),
        Ok(_) => panic!("unknown workspace_id should not resolve"),
    }
}

#[test]
fn resolve_workspace_reports_not_found_for_unknown_alias() {
    let workspaces = vec![test_relay_workspace("ws_1", Some("main"))];
    let lookup = test_workspace_lookup(&workspaces);

    match resolve_workspace(None, Some("nope"), &workspaces, &lookup, None) {
        Err(error) => assert!(
            error.starts_with("workspace_not_found:"),
            "unexpected error: {error}"
        ),
        Ok(_) => panic!("unknown workspace_alias should not resolve"),
    }
}

#[test]
fn default_observer_token_scopes_are_read_only_and_exclude_unneeded_scopes() {
    let scopes = default_observer_token_scopes();

    // Assert the *exact* set (not just "contains these 7"), so an
    // accidentally-added extra scope -- including a write scope -- fails this
    // test instead of silently widening the grant on a credential-minting
    // endpoint.
    let actual: HashSet<ObserverScope> = scopes.iter().copied().collect();
    let expected: HashSet<ObserverScope> = [
        ObserverScope::StreamRead,
        ObserverScope::MessagesRead,
        ObserverScope::ThreadsRead,
        ObserverScope::DmsRead,
        ObserverScope::ChannelsRead,
        ObserverScope::ActivityRead,
        ObserverScope::AgentsRead,
        ObserverScope::ReactionsRead,
    ]
    .into_iter()
    .collect();

    assert_eq!(
        scopes.len(),
        8,
        "expected exactly 8 default observer token scopes, got {scopes:?}"
    );
    assert_eq!(
        actual, expected,
        "default observer token scopes must be exactly the minimal read-only set"
    );
}

// ---------------------------------------------------------------------------
// mint_or_recover_observer_token
//
// `/api/observer-token` mints a fixed-name token (`pear-dashboard-observer`
// by default) per workspace with no way for the caller to know in advance
// whether a previous mint already claimed that name. relaycast enforces a
// `(workspace_id, name)` unique index, so a repeat mint fails with
// `observer_token_name_conflict` (409, relaycast#232). These tests cover
// the list+rotate fallback that makes repeat minting succeed anyway.
// ---------------------------------------------------------------------------

/// The exact serialized scope set the `/api/observer-token` endpoint mints
/// (`default_observer_token_scopes()`). A recovered token must carry exactly
/// this set (and no filters) for the list+rotate fallback to rotate it, so
/// the "happy path" test tokens are built with it.
fn default_observer_token_scope_strings() -> Vec<&'static str> {
    vec![
        "stream:read",
        "messages:read",
        "threads:read",
        "dms:read",
        "channels:read",
        "activity:read",
        "agents:read",
        "reactions:read",
    ]
}

fn observer_token_json(id: &str, name: &str, token: Option<&str>) -> serde_json::Value {
    observer_token_json_with_scopes(id, name, token, &default_observer_token_scope_strings())
}

fn observer_token_json_with_scopes(
    id: &str,
    name: &str,
    token: Option<&str>,
    scopes: &[&str],
) -> serde_json::Value {
    json!({
        "id": id,
        "name": name,
        "description": null,
        "scopes": scopes,
        "filters": {},
        "status": "active",
        "expires_at": null,
        "created_at": "2026-06-08T10:00:00.000Z",
        "updated_at": null,
        "revoked_at": null,
        "last_used_at": null,
        "token": token,
    })
}

fn observer_token_name_conflict_body() -> serde_json::Value {
    json!({
        "ok": false,
        "error": {
            "code": "observer_token_name_conflict",
            "message": "an observer token named 'pear-dashboard-observer' already exists",
        },
    })
}

#[tokio::test]
async fn observer_token_name_conflict_falls_back_to_list_and_rotate() {
    use httpmock::{
        Method::{GET, POST},
        MockServer,
    };

    let server = MockServer::start();
    let create_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens");
        then.status(409)
            .json_body(observer_token_name_conflict_body());
    });
    let list_mock = server.mock(|when, then| {
        when.method(GET).path("/v1/observer-tokens");
        then.status(200).json_body(json!({
            "ok": true,
            "data": [
                observer_token_json("ot_other", "some-other-observer", None),
                observer_token_json("ot_existing", "pear-dashboard-observer", None),
            ],
        }));
    });
    let rotate_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens/ot_existing/rotate");
        then.status(200).json_body(json!({
            "ok": true,
            "data": observer_token_json("ot_existing", "pear-dashboard-observer", Some("ot_live_rotated")),
        }));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

    let outcome =
        mint_or_recover_observer_token(&client, "pear-dashboard-observer", Duration::from_secs(2))
            .await
            .expect("name conflict should fall back to a recovered token, not fail");

    assert!(
        outcome.is_recovered_via_rotate(),
        "conflict fallback should report RecoveredViaRotate, not Created"
    );
    let token = outcome.into_token();
    assert_eq!(token.id, "ot_existing");
    assert_eq!(token.token.as_deref(), Some("ot_live_rotated"));

    create_mock.assert_hits(1);
    list_mock.assert_hits(1);
    rotate_mock.assert_hits(1);
}

#[tokio::test]
async fn observer_token_non_conflict_error_does_not_trigger_fallback() {
    use httpmock::{
        Method::{GET, POST},
        MockServer,
    };

    let server = MockServer::start();
    let create_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens");
        then.status(403).json_body(json!({
            "ok": false,
            "error": {
                "code": "forbidden",
                "message": "workspace key lacks permission to mint observer tokens",
            },
        }));
    });
    let list_mock = server.mock(|when, then| {
        when.method(GET).path("/v1/observer-tokens");
        then.status(200)
            .json_body(json!({ "ok": true, "data": [] }));
    });
    let rotate_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens/ot_existing/rotate");
        then.status(200).json_body(json!({
            "ok": true,
            "data": observer_token_json("ot_existing", "pear-dashboard-observer", Some("ot_live_rotated")),
        }));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

    let result =
        mint_or_recover_observer_token(&client, "pear-dashboard-observer", Duration::from_secs(2))
            .await;

    match result {
        Err(ObserverTokenMintError::Failed(message)) => {
            assert!(
                message.contains("forbidden"),
                "unexpected error message: {message}"
            );
        }
        Err(ObserverTokenMintError::TimedOut) => {
            panic!("a 403 should propagate as a failure, not a timeout")
        }
        Ok(ObserverTokenMintOutcome::Created(_)) => {
            panic!("a 403 create failure must not be reported as success")
        }
        Ok(ObserverTokenMintOutcome::RecoveredViaRotate(_)) => {
            panic!("a non-conflict error must not trigger the list+rotate fallback")
        }
    }

    create_mock.assert_hits(1);
    list_mock.assert_hits(0);
    rotate_mock.assert_hits(0);
}

#[tokio::test]
async fn observer_token_conflict_without_matching_name_propagates_original_error() {
    use httpmock::{
        Method::{GET, POST},
        MockServer,
    };

    let server = MockServer::start();
    let create_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens");
        then.status(409)
            .json_body(observer_token_name_conflict_body());
    });
    // The list doesn't contain a token under the attempted name -- e.g. a
    // race with a concurrent revoke between the conflicting create and this
    // recovery attempt. This must not panic; the original conflict error is
    // propagated as-is.
    let list_mock = server.mock(|when, then| {
        when.method(GET).path("/v1/observer-tokens");
        then.status(200).json_body(json!({
            "ok": true,
            "data": [observer_token_json("ot_other", "some-other-observer", None)],
        }));
    });
    let rotate_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/v1/observer-tokens/ot_other/rotate");
        then.status(200).json_body(json!({
            "ok": true,
            "data": observer_token_json("ot_other", "some-other-observer", Some("ot_live_rotated")),
        }));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

    let result =
        mint_or_recover_observer_token(&client, "pear-dashboard-observer", Duration::from_secs(2))
            .await;

    match result {
        Err(ObserverTokenMintError::Failed(message)) => {
            assert!(
                message.contains("observer_token_name_conflict"),
                "expected the original conflict error to propagate, got: {message}"
            );
        }
        _ => panic!(
            "expected the original conflict error to propagate when no matching name is \
             found, got a different outcome"
        ),
    }

    create_mock.assert_hits(1);
    list_mock.assert_hits(1);
    // Nothing matched `token_name`, so rotate must never be called against
    // an unrelated token.
    rotate_mock.assert_hits(0);
}

#[tokio::test]
async fn observer_token_conflict_with_mismatched_scopes_propagates_original_error() {
    use httpmock::{
        Method::{GET, POST},
        MockServer,
    };

    let server = MockServer::start();
    let create_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens");
        then.status(409)
            .json_body(observer_token_name_conflict_body());
    });
    // A token under the attempted name exists, but it was minted with a
    // broader scope set than `/api/observer-token` grants (here: an extra
    // `files:read`). Rotating and returning it would hand the caller
    // credentials with access this endpoint never promises, so the recovery
    // path must treat it as a non-match and let the original conflict
    // propagate rather than rotate it.
    let mut broader_scopes = default_observer_token_scope_strings();
    broader_scopes.push("files:read");
    let list_mock = server.mock(|when, then| {
        when.method(GET).path("/v1/observer-tokens");
        then.status(200).json_body(json!({
            "ok": true,
            "data": [observer_token_json_with_scopes(
                "ot_existing",
                "pear-dashboard-observer",
                None,
                &broader_scopes,
            )],
        }));
    });
    let rotate_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens/ot_existing/rotate");
        then.status(200).json_body(json!({
            "ok": true,
            "data": observer_token_json("ot_existing", "pear-dashboard-observer", Some("ot_live_rotated")),
        }));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

    let result =
        mint_or_recover_observer_token(&client, "pear-dashboard-observer", Duration::from_secs(2))
            .await;

    match result {
        Err(ObserverTokenMintError::Failed(message)) => {
            assert!(
                message.contains("observer_token_name_conflict"),
                "expected the original conflict error to propagate, got: {message}"
            );
        }
        _ => panic!(
            "expected the original conflict error to propagate when the existing token's \
             scopes don't match the endpoint contract, got a different outcome"
        ),
    }

    create_mock.assert_hits(1);
    list_mock.assert_hits(1);
    // The named token's scopes didn't match the contract, so it must never be
    // rotated.
    rotate_mock.assert_hits(0);
}

#[tokio::test]
async fn observer_token_fallback_respects_the_supplied_timeout() {
    use httpmock::{
        Method::{GET, POST},
        MockServer,
    };

    let server = MockServer::start();
    let create_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens");
        then.status(409)
            .json_body(observer_token_name_conflict_body());
    });
    // Slower than the timeout passed below, so the list+rotate fallback
    // itself must be bounded rather than left to hang indefinitely.
    let list_mock = server.mock(|when, then| {
        when.method(GET).path("/v1/observer-tokens");
        then.status(200)
            .delay(Duration::from_millis(300))
            .json_body(json!({
                "ok": true,
                "data": [observer_token_json("ot_existing", "pear-dashboard-observer", None)],
            }));
    });
    let rotate_mock = server.mock(|when, then| {
        when.method(POST).path("/v1/observer-tokens/ot_existing/rotate");
        then.status(200).json_body(json!({
            "ok": true,
            "data": observer_token_json("ot_existing", "pear-dashboard-observer", Some("ot_live_rotated")),
        }));
    });
    let client =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

    // 200ms comfortably exceeds the near-instant mocked create (so the shared
    // budget isn't exhausted before the conflict branch is even reached) yet
    // stays below the 300ms list delay, so the timeout can only fire inside
    // the list+rotate fallback -- which is exactly what this test exercises.
    let result = mint_or_recover_observer_token(
        &client,
        "pear-dashboard-observer",
        Duration::from_millis(200),
    )
    .await;

    match result {
        Err(ObserverTokenMintError::TimedOut) => {}
        Err(ObserverTokenMintError::Failed(message)) => {
            panic!("expected a timeout, got a non-timeout failure: {message}")
        }
        Ok(_) => panic!("a hung list+rotate fallback must not be reported as success"),
    }

    create_mock.assert_hits(1);
    list_mock.assert_hits(1);
    rotate_mock.assert_hits(0);
}

#[tokio::test]
async fn startup_queues_initial_task_before_early_events_without_exhausting_retries() {
    let name = "startup-order-proof";
    let mut workers = make_worker_registry_with_worker(name).await;
    workers
        .initial_tasks
        .insert(WorkerName::from(name), "Initial assignment".into());
    let mut incoming = make_pending_delivery("early-github", name);
    incoming.attempts = 0;
    let delivery = incoming.delivery.clone();
    let id = delivery.delivery_id.clone();
    let mut pending = HashMap::from([(id.clone(), incoming)]);
    for _ in 0..100 {
        let result = retry_pending_delivery(
            &id,
            &mut workers,
            &mut pending,
            Duration::from_millis(10),
            &mut crate::delivery::DeliverySeam::new(),
        )
        .await
        .unwrap();
        assert!(matches!(result, DeliveryAttemptOutcome::Noop));
    }
    assert_eq!(pending[&id].attempts, 0);
    assert_eq!(pending[&id].failed_attempts, 0);
    assert!(
        workers.deliver(name, delivery.clone()).await.is_err(),
        "manual delivery must obey startup ordering too"
    );
    // worker_ready removes the assignment and enqueues it synchronously before
    // maintenance can retry any previously parked external delivery.
    workers.initial_tasks.remove(name);
    let mut initial = delivery.clone();
    initial.event_id = EventId::new("init_assignment");
    workers.deliver(name, initial).await.unwrap();
    let result = retry_pending_delivery(
        &id,
        &mut workers,
        &mut pending,
        Duration::from_millis(10),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .unwrap();
    assert!(matches!(result, DeliveryAttemptOutcome::Attempted { .. }));
    assert_eq!(pending[&id].attempts, 1);
    workers.release(name).await.unwrap();
}

#[tokio::test]
async fn duplicate_http_spawn_preserves_live_identity_and_generation() {
    use crate::listen_api::ListenApiRequest;
    use tokio::sync::oneshot;
    let name = WorkerName::from("duplicate-owned-worker");
    let registry = make_worker_registry_with_worker(name.as_str()).await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let generation = fixture.runtime.workers.workers[&name].generation;
    let http = RelaycastHttpClient::new(
        Some("http://127.0.0.1:1".into()),
        "rk_live_fixture",
        "broker",
        "codex",
    );
    http.seed_agent_token(&name, "owned-token");
    fixture
        .runtime
        .workers
        .owned_spawn_generations
        .insert(name.clone(), (generation, http));
    let (reply, result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Spawn {
            name: name.clone(),
            cli: "codex".into(),
            transport: None,
            model: None,
            args: vec![],
            task: None,
            registration_metadata: Default::default(),
            channels: Some(vec![]),
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            continue_from: None,
            idle_threshold_secs: None,
            exit_after_task: false,
            skip_relay_prompt: true,
            restart_policy: Box::new(None),
            harness_config: None,
            agent_token: None,
            agent_result_schema: None,
            replay_buffer: crate::replay_buffer::ReplayBuffer::new(16),
            reply,
        })
        .await;
    assert!(result
        .await
        .unwrap()
        .unwrap_err()
        .contains("already exists"));
    assert_eq!(
        fixture.runtime.workers.owned_spawn_generations[&name].0,
        generation
    );
    assert_eq!(
        fixture.runtime.workers.workers[&name].generation,
        generation
    );
    assert!(!fixture
        .runtime
        .workers
        .identity_cleanups
        .contains_key(&name));
    assert!(
        fixture.fleet_control_rx.try_recv().is_err(),
        "duplicate must not register or deregister any identity"
    );
    fixture.runtime.workers.release(&name).await.unwrap();
}

#[tokio::test]
async fn tokenless_http_spawn_requires_create_only_before_fleet_registration() {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{Method::POST, MockServer};
    use tokio::sync::oneshot;
    let server = MockServer::start();
    let create = server.mock(|when, then| {
        when.method(POST).path("/v1/agents");
        then.status(409).json_body(
            json!({"ok":false,"error":{"code":"agent_already_exists","message":"name exists"}}),
        );
    });
    let registry = make_worker_registry_with_worker("unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    fixture.runtime.relaycast_http =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    let name = WorkerName::from("existing-remote-recipient");
    let (reply, result) = oneshot::channel();
    let request = ListenApiRequest::Spawn {
        name: name.clone(),
        cli: "codex".into(),
        transport: None,
        model: None,
        args: vec![],
        task: None,
        registration_metadata: Default::default(),
        channels: Some(vec![]),
        cwd: None,
        team: None,
        shadow_of: None,
        shadow_mode: None,
        continue_from: None,
        idle_threshold_secs: None,
        exit_after_task: false,
        skip_relay_prompt: true,
        restart_policy: Box::new(None),
        harness_config: None,
        agent_token: None,
        agent_result_schema: None,
        replay_buffer: crate::replay_buffer::ReplayBuffer::new(16),
        reply,
    };
    tokio::select! {
        _ = fixture.runtime.handle_api_request(request) => {},
        command = fixture.fleet_control_rx.recv() => panic!("must not adopt an existing identity through node control: {command:?}"),
        _ = tokio::time::sleep(Duration::from_secs(2)) => panic!("create-only refusal timed out"),
    }
    assert!(result.await.unwrap().is_err());
    create.assert_hits(1);
    assert!(!fixture
        .runtime
        .workers
        .identity_cleanups
        .contains_key(&name));
    assert!(!fixture
        .runtime
        .workers
        .owned_spawn_generations
        .contains_key(&name));
    fixture.runtime.workers.release("unrelated").await.unwrap();
}

#[tokio::test]
async fn owned_cleanup_retries_delete_without_repeating_acknowledged_deregistration() {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{Method::POST, MockServer};
    use tokio::sync::oneshot;
    let server = MockServer::start();
    let mut failed = server.mock(|when, then| {
        when.method(POST).path("/v1/agents/release");
        then.status(503);
    });
    let registry = make_worker_registry_with_worker("unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let name = WorkerName::from("delete-retry-recipient");
    let generation = Uuid::new_v4();
    let http = RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    http.seed_agent_token(&name, "owned-token");
    fixture
        .runtime
        .workers
        .owned_spawn_generations
        .insert(name.clone(), (generation, http));
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(name.to_string(), "owned-id".to_string());
    let (reply, mut result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: name.clone(),
            reason: None,
            expected_generation: Some(generation.to_string()),
            delete_identity: true,
            reply,
        })
        .await;
    loop {
        if let FleetControlCommand::DeregisterAgent { reply, .. } =
            fixture.fleet_control_rx.recv().await.unwrap()
        {
            reply.send(Ok(())).unwrap();
            break;
        }
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            fixture.runtime.reconcile_identity_cleanups().await;
            if let Ok(response) = result.try_recv() {
                assert!(response.is_err());
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    failed.assert_hits(1);
    failed.delete();
    let success = server.mock(|when, then| {
        when.method(POST).path("/v1/agents/release");
        then.status(200)
            .json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    fixture
        .runtime
        .workers
        .identity_cleanups
        .get_mut(&name)
        .unwrap()
        .retry_at = Instant::now();
    tokio::time::timeout(Duration::from_secs(2), async {
        while fixture
            .runtime
            .workers
            .identity_cleanups
            .contains_key(&name)
        {
            fixture.runtime.reconcile_identity_cleanups().await;
            while let Ok(command) = fixture.fleet_control_rx.try_recv() {
                assert!(
                    !matches!(command, FleetControlCommand::DeregisterAgent { .. }),
                    "acknowledged deregistration must not be repeated"
                );
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    success.assert_hits(1);
    assert!(!fixture
        .runtime
        .workers
        .owned_spawn_generations
        .contains_key(&name));
    fixture.runtime.workers.release("unrelated").await.unwrap();
}

#[tokio::test]
async fn name_only_release_of_retired_owned_worker_deletes_directly_and_is_idempotent() {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{Method::POST, MockServer};
    use tokio::sync::oneshot;

    let server = MockServer::start();
    let release = server.mock(|when, then| {
        when.method(POST).path("/v1/agents/release");
        then.status(200)
            .json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    let registry = make_worker_registry_with_worker("unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let name = WorkerName::from("retired-name-only");
    let generation = Uuid::new_v4();
    let http = RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    http.seed_agent_token(&name, "owned-token");
    fixture
        .runtime
        .workers
        .owned_spawn_generations
        .insert(name.clone(), (generation, http));
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(name.to_string(), "retired-name-only-id");

    let (reply, mut result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: name.clone(),
            reason: None,
            expected_generation: None,
            delete_identity: false,
            reply,
        })
        .await;
    let deregister = loop {
        if let FleetControlCommand::DeregisterAgent { reply, .. } =
            fixture.fleet_control_rx.recv().await.unwrap()
        {
            break reply;
        }
    };
    deregister.send(Ok(())).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            fixture.runtime.reconcile_identity_cleanups().await;
            if let Ok(response) = result.try_recv() {
                let response = response.expect("owned cleanup should succeed");
                assert_eq!(response["process"], "stopped");
                assert_eq!(response["identity"], "deleted");
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("name-only owned cleanup should complete");
    release.assert_hits(1);
    assert!(fixture
        .runtime
        .workers
        .completed_owned_releases
        .contains(&(name.clone(), generation)));

    // A repeated name-only release must use the completed tombstone and must
    // not route a second mutation through the host or a replacement identity.
    let (reply, repeated) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: name.clone(),
            reason: None,
            expected_generation: None,
            delete_identity: false,
            reply,
        })
        .await;
    let repeated = repeated
        .await
        .unwrap()
        .expect("repeat should be idempotent");
    assert_eq!(repeated["process"], "stopped");
    assert_eq!(repeated["identity"], "deleted");
    release.assert_hits(1);
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    fixture.runtime.workers.release("unrelated").await.unwrap();
}

#[tokio::test]
async fn completed_owned_release_history_keeps_prior_generation_idempotent_after_replacement_cleanup(
) {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{Method::POST, MockServer};
    use tokio::sync::oneshot;

    let server = MockServer::start();
    let release = server.mock(|when, then| {
        when.method(POST).path("/v1/agents/release");
        then.status(200)
            .json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    let name = WorkerName::from("retired-name-only");
    let stale_generation = Uuid::new_v4();
    let registry = make_worker_registry_with_worker(name.as_str()).await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let replacement_generation = fixture.runtime.workers.workers[&name].generation;
    let http = RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    http.seed_agent_token(&name, "replacement-owned-token");
    fixture
        .runtime
        .workers
        .completed_owned_releases
        .push_back((name.clone(), stale_generation));
    fixture
        .runtime
        .workers
        .owned_spawn_generations
        .insert(name.clone(), (replacement_generation, http));
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(name.to_string(), "replacement-owned-id");

    let (reply, result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: name.clone(),
            reason: None,
            expected_generation: Some(stale_generation.to_string()),
            delete_identity: true,
            reply,
        })
        .await;
    let error = result
        .await
        .unwrap()
        .expect_err("stale retry must not clean a live replacement");
    assert!(
        error.contains("generation changed") || error.contains("refusing"),
        "{error}"
    );
    release.assert_hits(0);

    let (reply, mut result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: name.clone(),
            reason: None,
            expected_generation: Some(replacement_generation.to_string()),
            delete_identity: true,
            reply,
        })
        .await;

    let deregister = loop {
        if let FleetControlCommand::DeregisterAgent { reply, .. } =
            fixture.fleet_control_rx.recv().await.unwrap()
        {
            break reply;
        }
    };
    deregister.send(Ok(())).unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            fixture.runtime.reconcile_identity_cleanups().await;
            if let Ok(response) = result.try_recv() {
                let response = response.expect("replacement cleanup should succeed");
                assert_eq!(response["process"], "stopped");
                assert_eq!(response["identity"], "deleted");
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("replacement cleanup should settle");
    release.assert_hits(1);
    assert!(fixture
        .runtime
        .workers
        .completed_owned_releases
        .contains(&(name.clone(), stale_generation)));
    assert_eq!(
        fixture.runtime.workers.completed_owned_releases.back(),
        Some(&(name.clone(), replacement_generation))
    );
    assert!(fixture.runtime.workers.owned_spawn_generations.is_empty());

    let (reply, result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: name.clone(),
            reason: None,
            expected_generation: Some(stale_generation.to_string()),
            delete_identity: true,
            reply,
        })
        .await;
    let response = result
        .await
        .unwrap()
        .expect("stale retry should be idempotent after replacement cleanup");
    assert_eq!(response["process"], "stopped");
    assert_eq!(response["identity"], "deleted");
    release.assert_hits(1);
    assert!(fixture.fleet_control_rx.try_recv().is_err());
}

#[tokio::test]
async fn completed_owned_release_history_is_bounded_and_evictions_drop_old_generations() {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{Method::POST, MockServer};
    use tokio::sync::oneshot;

    let server = MockServer::start();
    let release = server.mock(|when, then| {
        when.method(POST).path("/v1/agents/release");
        then.status(200)
            .json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    let registry = make_worker_registry_with_worker("unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let evicted_name = WorkerName::from("evicted-owned");
    let evicted_generation = Uuid::new_v4();
    fixture
        .runtime
        .workers
        .completed_owned_releases
        .push_back((evicted_name.clone(), evicted_generation));
    for index in 0..1023 {
        fixture
            .runtime
            .workers
            .completed_owned_releases
            .push_back((WorkerName::from(format!("filler-{index}")), Uuid::new_v4()));
    }
    assert_eq!(fixture.runtime.workers.completed_owned_releases.len(), 1024);

    let cleanup_name = WorkerName::from("cleanup-owned");
    let cleanup_generation = Uuid::new_v4();
    let cleanup_http =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    cleanup_http.seed_agent_token(&cleanup_name, "cleanup-owned-token");
    fixture
        .runtime
        .workers
        .owned_spawn_generations
        .insert(cleanup_name.clone(), (cleanup_generation, cleanup_http));
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(cleanup_name.to_string(), "cleanup-owned-id");

    let (reply, mut result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: cleanup_name.clone(),
            reason: None,
            expected_generation: Some(cleanup_generation.to_string()),
            delete_identity: true,
            reply,
        })
        .await;
    let deregister = loop {
        if let FleetControlCommand::DeregisterAgent { reply, .. } =
            fixture.fleet_control_rx.recv().await.unwrap()
        {
            break reply;
        }
    };
    deregister.send(Ok(())).unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            fixture.runtime.reconcile_identity_cleanups().await;
            if let Ok(response) = result.try_recv() {
                let response = response.expect("cleanup should succeed");
                assert_eq!(response["process"], "stopped");
                assert_eq!(response["identity"], "deleted");
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cleanup should settle");
    release.assert_hits(1);
    assert_eq!(fixture.runtime.workers.completed_owned_releases.len(), 1024);
    assert_ne!(
        fixture.runtime.workers.completed_owned_releases.front(),
        Some(&(evicted_name.clone(), evicted_generation))
    );

    let (reply, result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: evicted_name.clone(),
            reason: None,
            expected_generation: Some(evicted_generation.to_string()),
            delete_identity: true,
            reply,
        })
        .await;
    let error = result
        .await
        .unwrap()
        .expect_err("evicted generations must no longer be acknowledged");
    assert!(
        error.contains("generation changed") || error.contains("refusing"),
        "{error}"
    );
    release.assert_hits(1);
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    fixture.runtime.workers.release("unrelated").await.unwrap();
}

#[tokio::test]
async fn http_spawn_binding_failure_stops_before_launch_and_cleans_owned_identity() {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{
        Method::{GET, PATCH, POST},
        MockServer,
    };
    use tokio::sync::oneshot;

    let server = MockServer::start();
    let create = server.mock(|when, then| {
        when.method(POST).path("/v1/agents");
        then.status(201).json_body(json!({"ok":true,"data":{
            "id":"owned-binding-id","workspace_id":"ws_demo","name":"binding-refused",
            "status":"active","created_at":"2026-09-11T12:00:00Z","token":"at_live_binding_fixture"
        }}));
    });
    let bind = server.mock(|when, then| {
        when.method(POST).path("/v1/nodes/test-node/agents");
        then.status(503).json_body(json!({"ok":false,"error":{
            "code":"workspace_busy","message":"binding admission busy"
        }}));
    });
    let metadata = server.mock(|when, then| {
        when.method(PATCH).path("/v1/agents/binding-refused");
        then.status(200).json_body(json!({"ok":true,"data":{}}));
    });
    let scope = server.mock(|when, then| {
        when.method(GET).path("/v1/agents/binding-refused");
        then.status(200)
            .json_body(json!({"ok":true,"data":{"channels":[]}}));
    });
    let cleanup = server.mock(|when, then| {
        when.method(POST).path("/v1/agents/release");
        then.status(200)
            .json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    let registry = make_worker_registry_with_worker("unrelated-binding-worker").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    fixture.runtime.relaycast_http =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    let name = WorkerName::from("binding-refused");
    let (reply, mut result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Spawn {
            name: name.clone(),
            cli: "missing-binding-fixture-cli".into(),
            transport: None,
            model: None,
            args: vec![],
            task: None,
            registration_metadata: crate::fleet_wire::AgentRegistrationMetadata {
                organization: Some("original-spawn".into()),
                project: Some("must-not-leak-to-retry".into()),
                ..Default::default()
            },
            channels: Some(vec![]),
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            continue_from: None,
            idle_threshold_secs: None,
            exit_after_task: false,
            skip_relay_prompt: true,
            restart_policy: Box::new(None),
            harness_config: None,
            agent_token: None,
            agent_result_schema: None,
            replay_buffer: crate::replay_buffer::ReplayBuffer::new(16),
            reply,
        })
        .await;
    let response = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            fixture.runtime.reconcile_identity_cleanups().await;
            if let Ok(response) = result.try_recv() {
                break response;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    let unrelated_survived = fixture
        .runtime
        .workers
        .has_worker("unrelated-binding-worker");
    fixture
        .runtime
        .workers
        .release("unrelated-binding-worker")
        .await
        .unwrap();
    let error = response
        .expect("binding failure cleanup must settle")
        .unwrap_err();
    assert!(
        error.contains("binding") && error.contains("workspace_busy"),
        "{error}"
    );
    create.assert_hits(1);
    // The SDK retries an admission denial itself before surfacing the terminal
    // error; the broker adds no binding retry of its own, so once that error
    // arrives the spawn stops and cleans up without touching the bind again.
    // Capture the count here and prove it is final after the settle window.
    let bind_requests = bind.hits();
    assert!(bind_requests >= 1, "binding must have been attempted");
    // Let any incorrectly detached request run before the name can be reused.
    tokio::time::sleep(Duration::from_millis(100)).await;
    bind.assert_hits(bind_requests);
    metadata.assert_hits(0);
    scope.assert_hits(0);
    cleanup.assert_hits(1);
    assert!(unrelated_survived);
    assert!(!fixture.runtime.workers.has_worker(&name));
    assert!(!fixture
        .runtime
        .workers
        .identity_cleanups
        .contains_key(&name));
    assert!(!fixture
        .runtime
        .workers
        .owned_spawn_generations
        .contains_key(&name));
}

#[tokio::test]
async fn corrupt_owned_cleanup_journal_does_not_block_startup() {
    let registry = make_worker_registry_with_worker("unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let journal = fixture._temp_dir.path().join("owned-cleanups.json");
    std::fs::write(&journal, "{ this is not valid json").unwrap();
    fixture.runtime.workers.owned_cleanup_journal = Some(journal);

    super::identity_cleanup::restore_identity_cleanups(&mut fixture.runtime).unwrap();
    assert!(fixture.runtime.workers.identity_cleanups.is_empty());
    fixture.runtime.workers.release("unrelated").await.unwrap();
}

#[tokio::test]
async fn caller_owned_release_cannot_be_promoted_to_identity_deletion() {
    use crate::listen_api::ListenApiRequest;
    use tokio::sync::oneshot;

    let registry = make_worker_registry_with_worker("unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let name = WorkerName::from("caller-owned");
    let generation = Uuid::new_v4();
    let (reply, result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Release {
            name: name.clone(),
            reason: None,
            expected_generation: Some(generation.to_string()),
            delete_identity: true,
            reply,
        })
        .await;
    let error = result.await.unwrap().unwrap_err();
    assert!(error.contains("refusing"));
    assert!(!fixture
        .runtime
        .workers
        .owned_spawn_generations
        .contains_key(&name));
    assert!(!fixture
        .runtime
        .workers
        .identity_cleanups
        .contains_key(&name));
    fixture.runtime.workers.release("unrelated").await.unwrap();
}

#[tokio::test]
async fn owned_cleanup_journal_restores_generation_and_retries_without_plaintext_token() {
    use httpmock::{Method::POST, MockServer};

    let server = MockServer::start();
    let release = server.mock(|when, then| {
        when.method(POST)
            .path("/v1/agents/release")
            .json_body_partial(json!({
                "delete_agent": true,
                "expected_token_hash": "bec092bff160b23541205064ab9f4485d6c2089760b1bb4e5f5ce19f0274aad3"
            }).to_string());
        then.status(200)
            .json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    let registry = make_worker_registry_with_worker("unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    let name = WorkerName::from("restart-owned");
    let generation = Uuid::new_v4();
    let journal = fixture._temp_dir.path().join("owned-cleanups.json");
    std::fs::write(
        &journal,
        serde_json::to_vec(&json!({
            name.to_string(): {
                "generation": generation,
                "expected_token_hash": "bec092bff160b23541205064ab9f4485d6c2089760b1bb4e5f5ce19f0274aad3",
                "agent_id": null
            }
        }))
        .unwrap(),
    )
    .unwrap();
    fixture.runtime.workers.owned_cleanup_journal = Some(journal.clone());
    fixture.runtime.relaycast_http =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    super::identity_cleanup::restore_identity_cleanups(&mut fixture.runtime).unwrap();
    assert_eq!(
        fixture.runtime.workers.owned_spawn_generations[&name].0,
        generation
    );
    while fixture
        .runtime
        .workers
        .identity_cleanups
        .contains_key(&name)
    {
        fixture.runtime.reconcile_identity_cleanups().await;
        tokio::task::yield_now().await;
    }
    release.assert_hits(1);
    let persisted = std::fs::read_to_string(journal).unwrap();
    assert!(!persisted.contains("restart-owned"));
    fixture.runtime.workers.release("unrelated").await.unwrap();
}

#[tokio::test]
async fn local_only_queued_work_survives_restart_and_replays_when_recipient_reconnects() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pending.json");
    let id = DeliveryId::new("del_local_reconnect");
    let mut pending = HashMap::from([(
        id.clone(),
        pending_delivery("local-worker", id.as_str(), "local_reconnect"),
    )]);
    pending.get_mut(&id).unwrap().attempts = 0;
    pending.get_mut(&id).unwrap().delivery.workspace_id = Some(WorkspaceId::new("local"));
    pending.get_mut(&id).unwrap().delivery.workspace_alias = None;
    super::save_pending_deliveries(&path, &pending).unwrap();
    pending = load_pending_deliveries(&path);
    let (tx, _rx) = mpsc::channel(8);
    let mut absent = WorkerRegistry::new(tx, vec![], dir.path().join("logs"), Instant::now());
    assert!(matches!(
        retry_pending_delivery(
            &id,
            &mut absent,
            &mut pending,
            Duration::from_secs(1),
            &mut crate::delivery::DeliverySeam::new()
        )
        .await
        .unwrap(),
        DeliveryAttemptOutcome::Noop
    ));
    assert_eq!(pending[&id].attempts, 0);
    assert!(pending[&id]
        .last_error
        .as_deref()
        .unwrap()
        .contains("reconnect"));
    let mut reconnected = make_worker_registry_with_worker("local-worker").await;
    assert!(matches!(
        retry_pending_delivery(
            &id,
            &mut reconnected,
            &mut pending,
            Duration::from_secs(1),
            &mut crate::delivery::DeliverySeam::new()
        )
        .await
        .unwrap(),
        DeliveryAttemptOutcome::Attempted { .. }
    ));
    assert_eq!(pending[&id].attempts, 1);
    assert_eq!(pending[&id].delivery.event_id.as_str(), "local_reconnect");
    cleanup_worker_registry(reconnected).await;
}

#[tokio::test]
async fn local_only_exhausted_delivery_survives_absence_and_replays_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pending.json");
    let id = DeliveryId::new("del_local_exhausted");
    let mut entry = pending_delivery("local-worker", id.as_str(), "local_exhausted");
    entry.attempts = MAX_DELIVERY_RETRIES;
    entry.failed_attempts = MAX_DELIVERY_RETRIES;
    let expected_delivery = entry.delivery.clone();
    let mut pending = HashMap::from([(id.clone(), entry)]);
    // Exercise the live exhausted queue first: loading a snapshot resets the
    // failure budget and would hide an exhaustion check before absence handling.
    let (tx, _rx) = mpsc::channel(8);
    let mut absent = WorkerRegistry::new(tx, vec![], dir.path().join("logs"), Instant::now());
    for _ in 0..2 {
        assert!(matches!(
            retry_pending_delivery(
                &id,
                &mut absent,
                &mut pending,
                Duration::from_secs(1),
                &mut crate::delivery::DeliverySeam::new()
            )
            .await
            .unwrap(),
            DeliveryAttemptOutcome::Noop
        ));
        assert_eq!(pending[&id].delivery, expected_delivery);
        assert_eq!(pending[&id].attempts, MAX_DELIVERY_RETRIES);
        super::save_pending_deliveries(&path, &pending).unwrap();
        pending = load_pending_deliveries(&path);
    }
    let mut reconnected = make_worker_registry_with_worker("local-worker").await;
    let outcome = retry_pending_delivery(
        &id,
        &mut reconnected,
        &mut pending,
        Duration::from_secs(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .unwrap();
    cleanup_worker_registry(reconnected).await;
    assert!(matches!(outcome, DeliveryAttemptOutcome::Attempted { .. }));
    assert_eq!(pending[&id].delivery, expected_delivery);
    assert_eq!(pending[&id].attempts, MAX_DELIVERY_RETRIES + 1);
    assert_eq!(pending[&id].failed_attempts, 0);
}

#[tokio::test]
async fn local_only_restored_exhausted_delivery_replays_to_already_registered_worker() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pending.json");
    let id = DeliveryId::new("del_local_present_on_restart");
    let mut entry = pending_delivery("local-worker", id.as_str(), "local_present_on_restart");
    entry.attempts = MAX_DELIVERY_RETRIES;
    entry.failed_attempts = MAX_DELIVERY_RETRIES;
    let expected_delivery = entry.delivery.clone();
    super::save_pending_deliveries(&path, &HashMap::from([(id.clone(), entry)])).unwrap();
    let mut pending = load_pending_deliveries(&path);
    let mut workers = make_worker_registry_with_worker("local-worker").await;
    let outcome = retry_pending_delivery(
        &id,
        &mut workers,
        &mut pending,
        Duration::from_secs(1),
        &mut crate::delivery::DeliverySeam::new(),
    )
    .await
    .unwrap();
    cleanup_worker_registry(workers).await;
    assert!(matches!(outcome, DeliveryAttemptOutcome::Attempted { .. }));
    assert_eq!(pending[&id].delivery, expected_delivery);
    assert_eq!(pending[&id].attempts, MAX_DELIVERY_RETRIES + 1);
    assert_eq!(pending[&id].failed_attempts, 0);
}

#[tokio::test]
async fn http_spawn_supplied_token_publishes_declared_metadata() {
    assert_http_spawn_metadata_publication(true, true).await;
}

#[tokio::test]
async fn http_spawn_new_identity_publishes_declared_metadata() {
    assert_http_spawn_metadata_publication(false, true).await;
}

#[tokio::test]
async fn http_spawn_failed_launch_does_not_publish_declared_metadata() {
    assert_http_spawn_metadata_publication(true, false).await;
}

async fn assert_http_spawn_metadata_publication(supplied_token: bool, valid_cwd: bool) {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{
        Method::{GET, PATCH, POST},
        MockServer,
    };
    use tokio::sync::oneshot;

    let server = MockServer::start();
    let name = WorkerName::from("metadata-worker");
    let token = "at_live_metadata_fixture";
    let identity = json!({"id":"metadata-id","workspace_id":"ws_demo",
        "name":name,"status":"active","created_at":"2026-09-11T12:00:00Z"});
    let create = server.mock(|when, then| {
        when.method(POST).path("/v1/agents");
        let mut data = identity.clone();
        data["token"] = json!(token);
        then.status(201).json_body(json!({"ok":true,"data":data}));
    });
    let bind = server.mock(|when, then| {
        when.method(POST).path("/v1/nodes/test-node/agents");
        then.status(200).json_body(json!({"ok":true,"data":{
            "id":"binding-id", "agent_id":"metadata-id", "agent_name":"metadata-worker",
            "node_id":"node-id", "node_name":"test-node", "node_kind":"local", "node_role":"broker",
            "status":"active", "session_ref":null, "priority":0,
            "created_at":"2026-09-11T12:00:00Z", "updated_at":null
        }}));
    });
    let lookup = server.mock(|when, then| {
        when.method(GET)
            .path("/v1/agent")
            .header("authorization", format!("Bearer {token}"));
        then.status(200)
            .json_body(json!({"ok":true,"data":identity}));
    });
    server.mock(|when, then| {
        when.method(GET).path("/v1/agents/metadata-worker");
        then.status(200)
            .json_body(json!({"ok":true,"data":{"channels":[]}}));
    });
    let metadata = server.mock(|when, then| {
        when.method(PATCH)
            .path("/v1/agents/metadata-worker")
            .json_body(json!({"metadata":{
                "organization":"demo-org", "project":"demo-project",
                "workstream":"subscriptions", "role":"reviewer", "objective":"prove delivery"
            }}));
        then.status(200)
            .json_body(json!({"ok":true,"data":identity}));
    });
    let unexpected_cleanup = server.mock(|when, then| {
        when.method(POST).path("/v1/agents/release");
        then.status(500);
    });
    let dir = tempfile::tempdir().unwrap();
    let (events, _event_rx) = mpsc::channel(16);
    let registry = WorkerRegistry::new(events, vec![], dir.path().join("logs"), Instant::now());
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    fixture.runtime.relaycast_http =
        RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
    let (reply, result) = oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::Spawn {
            name: name.clone(),
            cli: "cat".into(),
            transport: None,
            model: None,
            args: vec![],
            task: None,
            registration_metadata: crate::fleet_wire::AgentRegistrationMetadata {
                organization: Some("demo-org".into()),
                project: Some("demo-project".into()),
                workstream: Some("subscriptions".into()),
                role: Some("reviewer".into()),
                objective: Some("prove delivery".into()),
            },
            channels: Some(vec![]),
            cwd: Some(
                if valid_cwd {
                    dir.path().to_path_buf()
                } else {
                    dir.path().join("missing")
                }
                .to_string_lossy()
                .into_owned(),
            ),
            team: None,
            shadow_of: None,
            shadow_mode: None,
            continue_from: None,
            idle_threshold_secs: None,
            exit_after_task: false,
            skip_relay_prompt: true,
            restart_policy: Box::new(None),
            harness_config: Some(crate::protocol::ResolvedHarnessConfig::Native(
                crate::protocol::NativeHarnessConfig {
                    command: "cat".into(),
                    args: vec![],
                    cwd: None,
                    env: None,
                    session_id: "metadata-session".into(),
                    metadata: None,
                },
            )),
            agent_token: supplied_token.then(|| token.to_string()),
            agent_result_schema: None,
            replay_buffer: crate::replay_buffer::ReplayBuffer::new(16),
            reply,
        })
        .await;
    let response = tokio::time::timeout(Duration::from_secs(3), result).await;
    // A fixture or admission regression must fail promptly rather than hang CI.
    // Stop the owned harness before assertions, including on a regression failure.
    fixture.runtime.workers.shutdown_all().await.unwrap();
    let response = response.expect("spawn reply must settle").unwrap();
    if valid_cwd {
        assert_eq!(response.unwrap()["success"], true);
        let published = tokio::time::timeout(Duration::from_secs(2), async {
            while metadata.hits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(
            published.is_ok(),
            "successful spawn did not publish declared metadata"
        );
        metadata.assert_hits(1);
    } else {
        assert!(response.unwrap_err().contains("cwd"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        metadata.assert_hits(0);
    }
    create.assert_hits(usize::from(!supplied_token));
    bind.assert_hits(usize::from(!supplied_token));
    lookup.assert_hits(1);
    unexpected_cleanup.assert_hits(0);
    assert!(!fixture
        .runtime
        .workers
        .identity_cleanups
        .contains_key(&name));
    if supplied_token {
        assert!(!fixture
            .runtime
            .workers
            .owned_spawn_generations
            .contains_key(&name));
    }
}

fn durable_task_fixture() -> WorkerEventRuntimeFixture {
    let (tx, _rx) = mpsc::channel(16);
    let workers = WorkerRegistry::new(tx, Vec::new(), std::env::temp_dir(), Instant::now());
    let mut fixture = worker_event_runtime_fixture(workers, HashMap::new());
    fixture.runtime.task_provider.store =
        super::task_store::TaskStore::open(fixture._temp_dir.path().join("tasks.json")).unwrap();
    fixture
}

async fn next_task_frame(
    fixture: &mut WorkerEventRuntimeFixture,
) -> crate::fleet_wire::BrokerToRelaycast {
    loop {
        if let FleetControlCommand::Send(message) =
            tokio::time::timeout(Duration::from_secs(2), fixture.fleet_control_rx.recv())
                .await
                .expect("task frame timeout")
                .unwrap()
        {
            return message;
        }
    }
}

async fn deliver_task_receipt(
    fixture: &mut WorkerEventRuntimeFixture,
    request: &str,
    status: &str,
) {
    let record = fixture.runtime.task_provider.store.records["inv-task"].clone();
    fixture
        .runtime
        .handle_fleet_control_event(crate::node_control::FleetControlEvent::Message(
            crate::fleet_wire::RelaycastToBroker::Reply(crate::fleet_wire::Reply {
                v: crate::fleet_wire::FLEET_WIRE_VERSION,
                id: request.to_owned(),
                ok: true,
                data: super::task_store::fixture_receipt(&record, status),
            }),
        ))
        .await;
}

#[tokio::test]
async fn durable_task_callback_waits_for_engine_final_receipt_and_retries_after_lost_ack() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let record = fixture
        .runtime
        .task_provider
        .store
        .prepare(super::task_store::fixture_invoke())
        .unwrap();
    fixture
        .runtime
        .task_provider
        .store
        .claim_launch("inv-task")
        .unwrap();
    let (reply, mut receiver) = tokio::sync::oneshot::channel();
    fixture
        .runtime
        .handle_api_request(crate::listen_api::ListenApiRequest::SubmitAgentResult {
            token: record.callback_token.clone(),
            name: Some(record.name.clone()),
            data: json!({"answer":42}),
            final_result: true,
            metadata: Some(json!({"accounting":{"tokens":17}})),
            reply,
        })
        .await;
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("expected accept reconciliation")
    };
    deliver_task_receipt(&mut fixture, &accept.id, "running").await;
    let BrokerToRelaycast::ActionResult(result) = next_task_frame(&mut fixture).await else {
        panic!("expected fenced final")
    };
    assert!(result.task.as_ref().unwrap().final_result);
    assert_eq!(
        result.task.as_ref().unwrap().worker_generation,
        record.generation.to_string()
    );
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    // Simulate lost result ACK: a new accept reconciles the same terminal record.
    fixture.runtime.task_provider.pending.clear();
    fixture.runtime.task_provider.last_retry = None;
    fixture.runtime.maintain_tasks().await;
    let BrokerToRelaycast::ActionAccept(reconcile) = next_task_frame(&mut fixture).await else {
        panic!("expected reconcile")
    };
    deliver_task_receipt(&mut fixture, &reconcile.id, "completed").await;
    let response = receiver.await.unwrap().unwrap();
    assert_eq!(response["receipt"]["output"], json!({"answer":42}));
    assert_eq!(
        response["receipt"]["task_execution"]["accounting"],
        json!({"tokens":17.0})
    );
    // Callback retry after HTTP response loss uses the saved receipt, no new worker or send.
    let (reply, receiver) = tokio::sync::oneshot::channel();
    fixture
        .runtime
        .handle_api_request(crate::listen_api::ListenApiRequest::SubmitAgentResult {
            token: record.callback_token,
            name: None,
            data: json!({"answer":42}),
            final_result: true,
            metadata: Some(json!({"accounting":{"tokens":17}})),
            reply,
        })
        .await;
    assert!(receiver.await.unwrap().is_ok());
    assert!(fixture.runtime.workers.workers.is_empty());
    assert!(fixture.fleet_control_rx.try_recv().is_err());
}

#[tokio::test]
async fn durable_task_interim_and_stale_generation_never_complete_callback_as_final() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let record = fixture
        .runtime
        .task_provider
        .store
        .prepare(super::task_store::fixture_invoke())
        .unwrap();
    fixture
        .runtime
        .task_provider
        .store
        .claim_launch("inv-task")
        .unwrap();
    let (reply, mut receiver) = tokio::sync::oneshot::channel();
    fixture
        .runtime
        .handle_api_request(crate::listen_api::ListenApiRequest::SubmitAgentResult {
            token: record.callback_token,
            name: None,
            data: json!({"ready":true}),
            final_result: false,
            metadata: None,
            reply,
        })
        .await;
    let BrokerToRelaycast::ActionResult(result) = next_task_frame(&mut fixture).await else {
        panic!("interim")
    };
    assert!(!result.task.as_ref().unwrap().final_result);
    assert!(receiver.try_recv().is_err());
    deliver_task_receipt(&mut fixture, result.id.as_deref().unwrap(), "running").await;
    assert_eq!(receiver.await.unwrap().unwrap()["final"], false);
    assert!(fixture.runtime.task_provider.store.records["inv-task"]
        .final_result
        .is_none());
    assert!(fixture.runtime.task_provider.store.records["inv-task"]
        .receipt
        .is_none());
}

#[tokio::test]
async fn durable_task_restart_of_claimed_launch_reports_loss_without_respawn() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let record = fixture
        .runtime
        .task_provider
        .store
        .prepare(super::task_store::fixture_invoke())
        .unwrap();
    fixture
        .runtime
        .task_provider
        .store
        .claim_launch("inv-task")
        .unwrap();
    fixture.runtime.task_provider.store =
        super::task_store::TaskStore::open(fixture._temp_dir.path().join("tasks.json")).unwrap();
    fixture.runtime.handle_task_invoke(record.invoke).await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };
    deliver_task_receipt(&mut fixture, &accept.id, "running").await;
    assert_eq!(
        fixture.runtime.task_provider.store.records["inv-task"]
            .final_result
            .as_ref()
            .unwrap()
            .error
            .as_deref(),
        Some("worker_execution_lost")
    );
    assert!(fixture.runtime.workers.workers.is_empty());
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("failure reconciliation")
    };
    deliver_task_receipt(&mut fixture, &accept.id, "running").await;
    let BrokerToRelaycast::ActionResult(result) = next_task_frame(&mut fixture).await else {
        panic!("failure")
    };
    assert!(matches!(
        result.result,
        crate::fleet_wire::ActionResultPayload::Error(_)
    ));
    deliver_task_receipt(&mut fixture, result.id.as_deref().unwrap(), "failed").await;
    assert_eq!(
        fixture.runtime.task_provider.store.records["inv-task"]
            .receipt
            .as_ref()
            .unwrap()["status"],
        "failed"
    );
}

#[tokio::test]
async fn durable_task_receipt_timeout_is_retryable_and_terminal_outbox_survives_disconnect() {
    let mut fixture = durable_task_fixture();
    let record = fixture
        .runtime
        .task_provider
        .store
        .prepare(super::task_store::fixture_invoke())
        .unwrap();
    fixture
        .runtime
        .task_provider
        .store
        .claim_launch("inv-task")
        .unwrap();
    fixture.runtime.node_delivery_connected = false;
    let (reply, mut receiver) = tokio::sync::oneshot::channel();
    fixture
        .runtime
        .handle_api_request(crate::listen_api::ListenApiRequest::SubmitAgentResult {
            token: record.callback_token,
            name: None,
            data: json!(42),
            final_result: true,
            metadata: None,
            reply,
        })
        .await;
    assert!(receiver.try_recv().is_err());
    fixture
        .runtime
        .task_provider
        .callbacks
        .get_mut("inv-task")
        .unwrap()[0]
        .0 = Instant::now() - Duration::from_secs(6);
    fixture.runtime.maintain_tasks().await;
    assert_eq!(
        receiver.await.unwrap(),
        Err(crate::listen_api::AgentResultRouteError::Retryable)
    );
    assert!(fixture.runtime.task_provider.store.records["inv-task"]
        .final_result
        .is_some());
    assert!(fixture.runtime.task_provider.store.records["inv-task"]
        .receipt
        .is_none());
}

#[tokio::test]
async fn durable_task_duplicate_invoke_and_launch_failure_are_generation_fenced() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let invoke = super::task_store::fixture_invoke();
    fixture.runtime.handle_task_invoke(invoke.clone()).await;
    fixture.runtime.handle_task_invoke(invoke).await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    // Missing CLI fails only after acceptance, through the explicit final-error path.
    deliver_task_receipt(&mut fixture, &accept.id, "running").await;
    let record = &fixture.runtime.task_provider.store.records["inv-task"];
    assert!(record.launch_claimed);
    assert_eq!(
        record.final_result.as_ref().unwrap().error.as_deref(),
        Some("task_missing_cli")
    );
    assert!(fixture.runtime.workers.workers.is_empty());
    // A repeated accepted receipt never attempts launch again.
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("reconcile")
    };
    deliver_task_receipt(&mut fixture, &accept.id, "running").await;
    assert!(matches!(
        next_task_frame(&mut fixture).await,
        BrokerToRelaycast::ActionResult(_)
    ));
}

#[tokio::test]
async fn durable_task_terminal_rejection_stops_worker_and_replay_stays_refused() {
    use crate::fleet_wire::{ActionResultPayload, BrokerToRelaycast};
    let mut fixture = durable_task_fixture();
    let invoke = super::task_store::fixture_invoke();
    fixture.runtime.handle_task_invoke(invoke.clone()).await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };
    let record = fixture.runtime.task_provider.store.records["inv-task"].clone();
    fixture
        .runtime
        .task_provider
        .store
        .claim_launch("inv-task")
        .unwrap();

    let mut workers = make_worker_registry_with_worker(record.name.as_str()).await;
    workers.workers.get_mut(&record.name).unwrap().generation = record.generation;
    let restart_policy = crate::supervisor::RestartPolicy {
        cooldown_ms: 0,
        ..crate::supervisor::RestartPolicy::default()
    };
    let mut spec = workers.workers[&record.name].spec.clone();
    spec.restart_policy = Some(restart_policy.clone());
    workers.supervisor.register(
        record.name.as_str(),
        crate::supervisor::SupervisedAgent {
            spec,
            parent: None,
            initial_task: None,
            skip_relay_prompt: false,
            agent_result: None,
        },
        restart_policy,
    );
    fixture.runtime.workers = workers;

    fixture
        .runtime
        .handle_task_error(crate::fleet_wire::Error {
            v: FLEET_WIRE_VERSION,
            id: accept.id,
            ok: false,
            code: "task_not_found".to_owned(),
            message: "task no longer exists".to_owned(),
        })
        .await;
    assert!(!fixture.runtime.workers.is_worker_live(&record.name));
    assert!(!fixture
        .runtime
        .workers
        .supervisor
        .is_supervised(&record.name));
    assert_eq!(
        fixture.runtime.task_provider.store.records["inv-task"]
            .rejection
            .as_deref(),
        Some("task_not_found")
    );

    fixture.runtime.handle_task_invoke(invoke).await;
    let BrokerToRelaycast::ActionResult(result) = next_task_frame(&mut fixture).await else {
        panic!("rejected replay must receive a terminal action result")
    };
    let ActionResultPayload::Error(error) = result.result else {
        panic!("rejected replay must fail")
    };
    assert_eq!(error.error, "handler_unavailable");
}

#[tokio::test]
async fn durable_task_maintenance_stops_claimed_worker_at_deadline() {
    let mut fixture = durable_task_fixture();
    let record = fixture
        .runtime
        .task_provider
        .store
        .prepare(super::task_store::fixture_invoke())
        .unwrap();
    fixture
        .runtime
        .task_provider
        .store
        .claim_launch("inv-task")
        .unwrap();
    let mut workers = make_worker_registry_with_worker(record.name.as_str()).await;
    workers.workers.get_mut(&record.name).unwrap().generation = record.generation;
    fixture.runtime.workers = workers;
    fixture
        .runtime
        .task_provider
        .store
        .records
        .get_mut("inv-task")
        .unwrap()
        .invoke
        .task_execution
        .as_mut()
        .unwrap()
        .deadline = (chrono::Utc::now() - chrono::Duration::seconds(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    fixture.runtime.node_delivery_connected = false;

    fixture.runtime.maintain_tasks().await;

    assert!(!fixture.runtime.workers.is_worker_live(&record.name));
    assert_eq!(
        fixture.runtime.task_provider.store.records["inv-task"]
            .final_result
            .as_ref()
            .unwrap()
            .error
            .as_deref(),
        Some("task_deadline_exceeded")
    );
}

#[tokio::test]
async fn durable_task_refusals_return_terminal_action_errors() {
    use crate::fleet_wire::{ActionResultPayload, BrokerToRelaycast};
    let mut fixture = durable_task_fixture();
    let invoke = super::task_store::fixture_invoke();
    fixture.runtime.handle_task_invoke(invoke.clone()).await;
    assert!(matches!(
        next_task_frame(&mut fixture).await,
        BrokerToRelaycast::ActionAccept(_)
    ));

    let mut conflicting = invoke.clone();
    conflicting.input["task"] = json!("different");
    fixture.runtime.handle_task_invoke(conflicting).await;
    let BrokerToRelaycast::ActionResult(conflict) = next_task_frame(&mut fixture).await else {
        panic!("conflicting invoke must receive a result")
    };
    let ActionResultPayload::Error(error) = conflict.result else {
        panic!("conflicting invoke must fail")
    };
    assert_eq!(error.error, "handler_unavailable");

    fixture.runtime.task_provider.store = Default::default();
    fixture.runtime.handle_task_invoke(invoke).await;
    let BrokerToRelaycast::ActionResult(disabled) = next_task_frame(&mut fixture).await else {
        panic!("disabled provider invoke must receive a result")
    };
    let ActionResultPayload::Error(error) = disabled.result else {
        panic!("disabled provider invoke must fail")
    };
    assert_eq!(error.error, "handler_unavailable");
}

#[tokio::test]
async fn durable_task_disk_failure_after_engine_commit_withholds_callback_ack() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let record = fixture
        .runtime
        .task_provider
        .store
        .prepare(super::task_store::fixture_invoke())
        .unwrap();
    fixture
        .runtime
        .task_provider
        .store
        .claim_launch("inv-task")
        .unwrap();
    let (reply, mut receiver) = tokio::sync::oneshot::channel();
    fixture
        .runtime
        .handle_api_request(crate::listen_api::ListenApiRequest::SubmitAgentResult {
            token: record.callback_token,
            name: None,
            data: json!(42),
            final_result: true,
            metadata: None,
            reply,
        })
        .await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };
    deliver_task_receipt(&mut fixture, &accept.id, "running").await;
    let BrokerToRelaycast::ActionResult(result) = next_task_frame(&mut fixture).await else {
        panic!("result")
    };
    let path = fixture._temp_dir.path().join("tasks.json");
    let persisted = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    deliver_task_receipt(&mut fixture, result.id.as_deref().unwrap(), "completed").await;
    assert!(receiver.try_recv().is_err());
    assert!(!fixture.runtime.task_provider.store.enabled());
    assert!(fixture.runtime.task_provider.store.records["inv-task"]
        .receipt
        .is_none());
    // Reopen a recovered durable outbox and reconcile the already committed result.
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, persisted).unwrap();
    fixture.runtime.task_provider.store = super::task_store::TaskStore::open(path).unwrap();
    fixture.runtime.task_provider.last_retry = None;
    fixture.runtime.maintain_tasks().await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("reconcile")
    };
    deliver_task_receipt(&mut fixture, &accept.id, "completed").await;
    assert!(receiver.await.unwrap().is_ok());
    assert!(fixture.runtime.workers.workers.is_empty());
}

#[tokio::test]
async fn durable_task_expired_unaccepted_receipt_never_launches_worker() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let mut invoke = super::task_store::fixture_invoke();
    invoke.task_execution.as_mut().unwrap().deadline = (chrono::Utc::now()
        - chrono::Duration::minutes(1))
    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    fixture.runtime.handle_task_invoke(invoke).await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };
    let record = fixture.runtime.task_provider.store.records["inv-task"].clone();
    let mut receipt = super::task_store::fixture_receipt(&record, "failed");
    receipt["error"] = json!("task_deadline_exceeded");
    receipt["task_execution"]
        .as_object_mut()
        .unwrap()
        .remove("worker_generation");
    fixture
        .runtime
        .handle_task_reply(crate::fleet_wire::Reply {
            v: FLEET_WIRE_VERSION,
            id: accept.id,
            ok: true,
            data: receipt,
        })
        .await;
    assert!(fixture.runtime.workers.workers.is_empty());
    assert!(!fixture.runtime.task_provider.store.records["inv-task"].launch_claimed);
    assert_eq!(
        fixture.runtime.task_provider.store.records["inv-task"]
            .receipt
            .as_ref()
            .unwrap()["error"],
        "task_deadline_exceeded"
    );
}

#[tokio::test]
async fn durable_task_expired_running_receipt_queues_terminal_deadline_failure() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let mut invoke = super::task_store::fixture_invoke();
    invoke.task_execution.as_mut().unwrap().deadline = (chrono::Utc::now()
        - chrono::Duration::minutes(1))
    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    fixture.runtime.handle_task_invoke(invoke).await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };

    deliver_task_receipt(&mut fixture, &accept.id, "running").await;
    let record = &fixture.runtime.task_provider.store.records["inv-task"];
    assert!(!record.launch_claimed);
    assert_eq!(
        record.final_result.as_ref().unwrap().error.as_deref(),
        Some("task_deadline_exceeded")
    );
    let BrokerToRelaycast::ActionAccept(reconcile) = next_task_frame(&mut fixture).await else {
        panic!("reconcile")
    };
    deliver_task_receipt(&mut fixture, &reconcile.id, "running").await;
    let BrokerToRelaycast::ActionResult(result) = next_task_frame(&mut fixture).await else {
        panic!("result")
    };
    let crate::fleet_wire::ActionResultPayload::Error(error) = result.result else {
        panic!("deadline failure")
    };
    assert_eq!(error.error, "task_deadline_exceeded");
    assert!(result.task.as_ref().unwrap().final_result);
}

#[tokio::test]
async fn durable_task_reply_deadline_stops_a_live_worker() {
    // Once `fail_task` sets `final_result`, `maintain_tasks`'s expired-claimed
    // sweep skips the record (it only chases records still outcome-less) --
    // this reply-path deadline check is the only remaining chance to stop a
    // worker that is still live when the accept-reply deadline expires while
    // the engine reports "running".
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let invoke = super::task_store::fixture_invoke();
    fixture.runtime.handle_task_invoke(invoke).await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };
    let record = fixture.runtime.task_provider.store.records["inv-task"].clone();
    let mut workers = make_worker_registry_with_worker(record.name.as_str()).await;
    workers.workers.get_mut(&record.name).unwrap().generation = record.generation;
    fixture.runtime.workers = workers;
    assert!(fixture.runtime.workers.is_worker_live(&record.name));
    fixture
        .runtime
        .task_provider
        .store
        .records
        .get_mut("inv-task")
        .unwrap()
        .invoke
        .task_execution
        .as_mut()
        .unwrap()
        .deadline = (chrono::Utc::now() - chrono::Duration::seconds(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    deliver_task_receipt(&mut fixture, &accept.id, "running").await;

    assert!(!fixture.runtime.workers.is_worker_live(&record.name));
    assert_eq!(
        fixture.runtime.task_provider.store.records["inv-task"]
            .final_result
            .as_ref()
            .unwrap()
            .error
            .as_deref(),
        Some("task_deadline_exceeded")
    );
}

#[tokio::test]
async fn durable_task_old_attempt_receipt_cannot_start_new_generation() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let invoke = super::task_store::fixture_invoke();
    fixture.runtime.handle_task_invoke(invoke.clone()).await;
    let original = fixture.runtime.task_provider.store.records["inv-task"].clone();
    let BrokerToRelaycast::ActionAccept(old) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };
    let mut next = invoke;
    next.task_execution.as_mut().unwrap().execution_id = "inv-task/2".into();
    fixture.runtime.handle_task_invoke(next).await;
    fixture
        .runtime
        .handle_task_reply(crate::fleet_wire::Reply {
            v: FLEET_WIRE_VERSION,
            id: old.id,
            ok: true,
            data: super::task_store::fixture_receipt(&original, "running"),
        })
        .await;
    assert!(!fixture.runtime.task_provider.store.records["inv-task"].launch_claimed);
    assert_ne!(
        fixture.runtime.task_provider.store.records["inv-task"].generation,
        original.generation
    );
    assert!(fixture
        .runtime
        .task_provider
        .store
        .by_token(&original.callback_token)
        .is_none());
    assert!(fixture.runtime.workers.workers.is_empty());
}

#[tokio::test]
async fn durable_task_numeric_output_and_accounting_reconcile_javascript_json() {
    use crate::fleet_wire::BrokerToRelaycast;
    let mut fixture = durable_task_fixture();
    let record = fixture
        .runtime
        .task_provider
        .store
        .prepare(super::task_store::fixture_invoke())
        .unwrap();
    fixture
        .runtime
        .task_provider
        .store
        .claim_launch("inv-task")
        .unwrap();
    let (reply, receiver) = tokio::sync::oneshot::channel();
    fixture
        .runtime
        .handle_api_request(crate::listen_api::ListenApiRequest::SubmitAgentResult {
            token: record.callback_token,
            name: None,
            data: json!({"answer":42.0}),
            final_result: true,
            metadata: Some(json!({"accounting":{"tokens":17.0}})),
            reply,
        })
        .await;
    let BrokerToRelaycast::ActionAccept(accept) = next_task_frame(&mut fixture).await else {
        panic!("accept")
    };
    let record = fixture.runtime.task_provider.store.records["inv-task"].clone();
    let mut receipt = super::task_store::fixture_receipt(&record, "completed");
    receipt["output"] = json!({"answer":42});
    receipt["task_execution"]["accounting"] = json!({"tokens":17});
    fixture
        .runtime
        .handle_task_reply(crate::fleet_wire::Reply {
            v: FLEET_WIRE_VERSION,
            id: accept.id,
            ok: true,
            data: receipt,
        })
        .await;
    assert!(receiver.await.unwrap().is_ok());
}

/// Register a worker that is present but whose stdin writer is gone.
///
/// Sends to it fail in `send_to_worker_with_commit_boundary` at
/// `command_tx.send(..)` — strictly before any byte reaches the pipe — so the
/// failure is a genuine `PreWrite`, produced by production code and repeatable
/// without any timing dependency. `has_worker` stays true throughout, which is
/// what separates this from "the recipient is gone".
async fn make_registry_with_writerless_worker(name: &str) -> WorkerRegistry {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let mut registry = WorkerRegistry::new(
        tx,
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let child = tokio::process::Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("test worker process should spawn");
    let (command_tx, command_rx) = mpsc::channel(128);
    // No writer task: dropping the receiver makes every send fail before a
    // write is attempted.
    drop(command_rx);
    registry.workers.insert(
        WorkerName::from(name),
        WorkerHandle {
            generation: Uuid::new_v4(),
            spec: AgentSpec {
                name: WorkerName::from(name),
                runtime: AgentRuntime::Pty,
                provider: None,
                cli: Some("cat".to_string()),
                session_id: None,
                harness_config: None,
                model: None,
                cwd: None,
                team: None,
                shadow_of: None,
                shadow_mode: None,
                args: Vec::new(),
                channels: Vec::new(),
                restart_policy: None,
            },
            parent: None,
            workspace_id: Some(WorkspaceId::new("ws_demo")),
            child,
            command_tx,
            harness_pid: None,
            spawned_at: Instant::now(),
            ready_at: Some(Instant::now()),
            last_activity_at: Instant::now(),
            context_budget_pct: None,
            state: AgentWorkState::Working,
            exit_reason: None,
        },
    );
    registry
}

/// The retry cap has to be *reached*, not just declared.
///
/// Other `retry_pending_delivery` callers cover many starting states, including
/// zero. None of those tests walks one repeatable pre-write failure through
/// every increment to the cap, so the individual snapshots could all pass if
/// the retry lifecycle stopped advancing between them.
///
/// This walks the whole lifecycle from `attempts: 0` on a repeatable pre-write
/// error: each attempt must increment the counter and leave the entry pending,
/// and only the attempt at the cap may terminate it into the dead-letter path.
#[tokio::test]
async fn delivery_retry_walks_the_cap_from_zero_and_then_dead_letters() {
    let worker_name = "worker-writerless";
    let mut workers = make_registry_with_writerless_worker(worker_name).await;

    let mut pending_deliveries = HashMap::from([(
        DeliveryId::new("del_cap_walk"),
        PendingDelivery {
            worker_name: WorkerName::from(worker_name),
            delivery: RelayDelivery {
                delivery_id: DeliveryId::new("del_cap_walk"),
                event_id: EventId::new("evt_cap_walk"),
                workspace_id: Some(WorkspaceId::new("ws_demo")),
                workspace_alias: Some(WorkspaceAlias::new("Demo")),
                from: "orchestrator".to_string(),
                target: MessageTarget::new(worker_name),
                body: "walk the cap".to_string(),
                thread_id: None,
                priority: Some(2),
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 0,
            failed_attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    )]);

    let mut seam = crate::delivery::DeliverySeam::new();
    let mut terminal = None;

    for attempt in 1..=MAX_DELIVERY_RETRIES + 1 {
        let outcome = retry_pending_delivery(
            &DeliveryId::new("del_cap_walk"),
            &mut workers,
            &mut pending_deliveries,
            Duration::from_millis(1),
            &mut seam,
        )
        .await
        .expect("a pre-write refusal is retriable, not an error");

        assert!(
            workers.has_worker(worker_name),
            "the recipient must stay present; this is a writer fault, not a missing agent"
        );

        match outcome {
            // A retriable failure below the cap keeps the delivery queued and
            // reports `Noop` — `Attempted` is reserved for a send that actually
            // went out. What has to hold here is the bookkeeping: the counters
            // advance, so the cap is reachable.
            DeliveryAttemptOutcome::Noop => {
                assert!(
                    attempt < MAX_DELIVERY_RETRIES,
                    "the attempt at the cap must terminate, not queue another retry"
                );
                let entry = pending_deliveries
                    .get("del_cap_walk")
                    .expect("a below-cap failure keeps the delivery pending");
                assert_eq!(
                    entry.failed_attempts, attempt,
                    "each retriable failure must increment failed_attempts, or the cap is never reached"
                );
                assert_eq!(
                    entry.attempts, attempt,
                    "the pending entry must record the attempt"
                );
                assert!(
                    entry
                        .last_error
                        .as_deref()
                        .unwrap_or_default()
                        .contains(worker_name),
                    "the pending entry must carry the failure that caused the retry"
                );
            }
            DeliveryAttemptOutcome::Failed {
                pending,
                last_error,
            } => {
                assert_eq!(
                    attempt, MAX_DELIVERY_RETRIES,
                    "terminal failure must arrive exactly at the cap, not before"
                );
                assert_eq!(
                    pending.failed_attempts, MAX_DELIVERY_RETRIES,
                    "the terminal entry must show a fully consumed retry budget"
                );
                assert!(
                    last_error.contains(worker_name),
                    "the terminal error must name the worker that could not be written to"
                );
                terminal = Some(*pending);
                break;
            }
            other => panic!(
                "a pre-write refusal must stay retriable until the cap, got {other:?} on attempt {attempt}"
            ),
        }
    }

    let terminal = terminal.expect("walking the cap must end in a terminal failure");
    assert_eq!(terminal.delivery.delivery_id.as_str(), "del_cap_walk");
    assert!(
        pending_deliveries.is_empty(),
        "a terminally failed delivery must leave the pending map for the dead-letter store"
    );
}

/// A handed-over delivery that exhausts its retries is IN DOUBT, not failed.
///
/// One successful hand-off whose ack never arrives returns `AlreadySent` on
/// every later tick, so `failed_attempts` climbs to the cap without anything
/// being re-written. It then reached the cap branch and was dead-lettered as
/// `Failed` — a reason with no in-doubt marker, so `is_auto_redeliverable`
/// returns true and an operator redelivery re-sends a message that may already
/// have landed. That is the double delivery rule 2 exists to prevent, arrived
/// at through the ordinary un-acked path rather than through any error.
///
/// The discriminator is whether the seam holds a receipt: only it knows if
/// anything ever went out over a transport.
#[tokio::test]
async fn a_handed_over_delivery_that_exhausts_retries_is_in_doubt_not_failed() {
    let worker_name = "worker-handed-over";
    let mut workers = make_worker_registry_with_worker(worker_name).await;
    let mut seam = crate::delivery::DeliverySeam::new();

    let mut pending_deliveries = HashMap::from([(
        DeliveryId::new("del_handed"),
        PendingDelivery {
            worker_name: WorkerName::from(worker_name),
            delivery: RelayDelivery {
                delivery_id: DeliveryId::new("del_handed"),
                event_id: EventId::new("evt_handed"),
                workspace_id: Some(WorkspaceId::new("ws_demo")),
                workspace_alias: Some(WorkspaceAlias::new("Demo")),
                from: "orchestrator".to_string(),
                target: MessageTarget::new(worker_name),
                body: "handed over, never acked".to_string(),
                thread_id: None,
                priority: Some(2),
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 0,
            failed_attempts: 0,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    )]);

    // One real hand-off: the worker is alive, so this writes and records a
    // receipt against the pty route.
    let first = retry_pending_delivery(
        &DeliveryId::new("del_handed"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
        &mut seam,
    )
    .await
    .expect("the first attempt should hand the delivery to the pty route");
    assert!(
        matches!(first, DeliveryAttemptOutcome::Attempted { .. }),
        "precondition: the first attempt must actually send, got {first:?}"
    );
    assert!(
        seam.recorded_route(&DeliveryId::new("del_handed"))
            .is_some(),
        "precondition: the seam must hold a receipt after a successful hand-off"
    );

    // Drive the remaining ticks. No ack ever arrives, so every one of these is
    // `AlreadySent` -> Noop, incrementing failed_attempts without re-writing.
    let mut terminal = None;
    for _ in 0..=MAX_DELIVERY_RETRIES + 1 {
        let outcome = retry_pending_delivery(
            &DeliveryId::new("del_handed"),
            &mut workers,
            &mut pending_deliveries,
            Duration::from_millis(1),
            &mut seam,
        )
        .await
        .expect("an un-acked hand-off is not an error");
        match outcome {
            DeliveryAttemptOutcome::Noop => continue,
            other => {
                terminal = Some(other);
                break;
            }
        }
    }

    let terminal = terminal.expect("the retry budget must terminate");
    let DeliveryAttemptOutcome::TerminalInDoubt { .. } = &terminal else {
        panic!(
            "a delivery the seam handed to a route must terminate IN DOUBT so it is \
             dead-lettered non-redeliverable, got {terminal:?}"
        );
    };

    // Drive the production outcome handler and inspect the store it writes.
    // Formatting a prefix locally would keep this test green if production
    // stopped adding the marker and made the message auto-redeliverable.
    let (sdk_out_tx, _sdk_out_rx) = mpsc::channel(4);
    let mut dead_letters = DeadLetterStore::default();
    emit_delivery_attempt_outcome(
        &sdk_out_tx,
        &mut dead_letters,
        &DeliveryId::new("del_handed"),
        true,
        terminal,
    )
    .await
    .expect("the terminal in-doubt outcome must emit");
    let reason = dead_letters
        .get("del_handed")
        .expect("the terminal in-doubt outcome must enter the dead-letter store")
        .reason
        .clone();
    assert!(
        !crate::runtime::dead_letter::is_auto_redeliverable(&reason),
        "a possible write must never be queued for automatic redelivery: {reason}"
    );
}

/// A delivery whose receipt aged out is still a possible write.
///
/// The cap branch first asked `recorded_route`, which answers `None` for two
/// opposite facts: never sent, and sent over a route the seam has since
/// forgotten. Under sustained load the second is routine — receipts are
/// bounded and nothing removes them on ack — so a delivery that WAS handed to
/// a live PTY fell through to `Failed`, was dead-lettered without the in-doubt
/// marker, and became eligible for operator redelivery. That is the double
/// delivery the in-doubt disposition exists to prevent, restored by a cache
/// eviction.
#[tokio::test]
async fn an_evicted_receipt_still_terminates_in_doubt_not_failed() {
    let worker_name = "worker-evicted";
    let mut workers = make_worker_registry_with_worker(worker_name).await;
    let mut seam = crate::delivery::DeliverySeam::new();
    let target = DeliveryId::new("del_evicted_cap");

    let mut pending_deliveries = HashMap::from([(
        target.clone(),
        PendingDelivery {
            worker_name: WorkerName::from(worker_name),
            delivery: RelayDelivery {
                delivery_id: target.clone(),
                event_id: EventId::new("evt_evicted_cap"),
                workspace_id: Some(WorkspaceId::new("ws_demo")),
                workspace_alias: Some(WorkspaceAlias::new("Demo")),
                from: "orchestrator".to_string(),
                target: MessageTarget::new(worker_name),
                body: "handed over, then forgotten".to_string(),
                thread_id: None,
                priority: Some(2),
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 0,
            failed_attempts: MAX_DELIVERY_RETRIES,
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
            withheld_fleet_ack: None,
            withheld_fleet_ack_floor: None,
            sent_route: None,
        },
    )]);

    // Hand the delivery over for real, then push its receipt out of the
    // seam's bounded memory with unrelated traffic.
    let relay_for = |id: &DeliveryId| RelayDelivery {
        delivery_id: id.clone(),
        event_id: EventId::new(format!("evt_{}", id.as_str())),
        workspace_id: Some(WorkspaceId::new("ws_demo")),
        workspace_alias: Some(WorkspaceAlias::new("Demo")),
        from: "orchestrator".to_string(),
        target: MessageTarget::new(worker_name),
        body: "payload".to_string(),
        thread_id: None,
        priority: Some(2),
        injection_mode: MessageInjectionMode::Wait,
    };

    let mut pty = crate::delivery::pty::PtyDeliveryBackend::new(&mut workers);
    seam.send(
        &mut [&mut pty],
        crate::delivery::SendRequest::relay(WorkerName::from(worker_name), relay_for(&target)),
    )
    .await
    .expect("the first hand-off should be recorded");
    assert!(
        seam.recorded_route(&target).is_some(),
        "precondition: a receipt must exist before eviction"
    );

    for index in 0..crate::delivery::DeliverySeam::max_receipts() {
        let filler = DeliveryId::new(format!("del_filler_{index}"));
        let _ = seam
            .send(
                &mut [&mut pty],
                crate::delivery::SendRequest::relay(
                    WorkerName::from(worker_name),
                    relay_for(&filler),
                ),
            )
            .await;
    }
    drop(pty);

    assert!(
        seam.recorded_route(&target).is_none(),
        "precondition: the receipt must have been evicted"
    );
    assert!(
        seam.was_sent(&target),
        "the seam must still know it sent this, or the cap branch cannot tell \
         an evicted write from a message that never left"
    );

    let outcome = retry_pending_delivery(
        &target,
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
        &mut seam,
    )
    .await
    .expect("reaching the cap is not an error");

    let DeliveryAttemptOutcome::TerminalInDoubt { last_error, .. } = outcome else {
        panic!(
            "a delivery whose receipt was evicted was still WRITTEN, so it must \
             terminate in doubt and stay off auto-redelivery, got {outcome:?}"
        );
    };
    let reason = format!(
        "{}{last_error}",
        crate::runtime::dead_letter::IN_DOUBT_REASON_PREFIX
    );
    assert!(
        !crate::runtime::dead_letter::is_auto_redeliverable(&reason),
        "an evicted possible-write must never be queued for redelivery: {reason}"
    );
}

/// An in-doubt delivery on the raw queue path must not vanish.
///
/// `retry_pending_delivery` removes the entry on `TerminalInDoubt`, and
/// `insert_and_attempt_delivery` used to return the typed error without
/// preserving it. Its only fleet caller logs a warning and returns, so the
/// message left no dead letter, no `MessageDeliveryFailed`, and nothing on the
/// wire — the body was simply gone. The `Failed` arm beside it has re-inserted
/// for exactly this reason all along.
///
/// Retained at the cap, so the next pass terminates it in doubt again and the
/// outcome handler dead-letters it non-redeliverable rather than re-sending.
#[tokio::test]
async fn an_in_doubt_delivery_on_the_raw_queue_path_is_retained_not_dropped() {
    let worker_name = "worker-raw-indoubt";
    let mut workers = make_worker_registry_with_worker(worker_name).await;
    // Kill the child so the very next write fails past the commit boundary.
    {
        let handle = workers
            .workers
            .get_mut(worker_name)
            .expect("present worker handle");
        let _ = handle.child.start_kill();
        let _ = handle.child.wait().await;
    }

    let mut pending_deliveries: HashMap<DeliveryId, PendingDelivery> = HashMap::new();
    let mut seam = crate::delivery::DeliverySeam::new();

    let err = super::delivery::insert_and_attempt_delivery(
        &mut workers,
        &mut pending_deliveries,
        worker_name,
        RelayDelivery {
            delivery_id: DeliveryId::new("del_raw_indoubt"),
            event_id: EventId::new("evt_raw_indoubt"),
            workspace_id: Some(WorkspaceId::new("ws_demo")),
            workspace_alias: Some(WorkspaceAlias::new("Demo")),
            from: "orchestrator".to_string(),
            target: MessageTarget::new(worker_name),
            body: "body that must not vanish".to_string(),
            thread_id: None,
            priority: Some(2),
            injection_mode: MessageInjectionMode::Wait,
        },
        Duration::from_millis(1),
        None,
        None,
        &mut seam,
    )
    .await
    .expect_err("a committed write failure must surface as in doubt");

    assert!(
        err.downcast_ref::<crate::runtime::delivery::TerminalInDoubtError>()
            .is_some(),
        "the caller must be able to tell a possible write from a failed one, got {err:?}"
    );

    assert_eq!(
        pending_deliveries.len(),
        1,
        "an in-doubt delivery must be retained so something can dead-letter it; \
         dropping it here is a message lost with no operator-visible record"
    );
    let retained = pending_deliveries
        .values()
        .next()
        .expect("the retained entry");
    assert_eq!(
        retained.delivery.body, "body that must not vanish",
        "the body must survive for the dead-letter store"
    );
    assert_eq!(
        retained.failed_attempts, MAX_DELIVERY_RETRIES,
        "retained at the cap, so the next pass terminates it instead of re-sending a possible write"
    );
}

/// A backend that reports a native route's hand-over without touching a real
/// Codex install. Named for the route it claims, because the route string is
/// what `survives_broker_restart` and the teardown label both key off.
struct HandedOverNativeRoute {
    route: &'static str,
}

impl crate::delivery::DeliveryBackend for HandedOverNativeRoute {
    fn route_id(&self) -> crate::delivery::RouteId {
        crate::delivery::RouteId::new(self.route)
    }

    fn transport_status(&mut self) -> crate::delivery::TransportStatus {
        crate::delivery::TransportStatus::Available
    }

    fn send<'a>(
        &'a mut self,
        _request: &'a crate::delivery::SendRequest,
    ) -> crate::delivery::DeliveryBackendFuture<
        'a,
        Result<crate::delivery::SendStatus, crate::delivery::DeliveryError>,
    > {
        Box::pin(async {
            Ok(crate::delivery::SendStatus::HandedOver(
                crate::delivery::HandoverState::HandedOver,
            ))
        })
    }

    fn settle<'a>(
        &'a mut self,
        _request: &'a crate::delivery::SettleRequest,
    ) -> crate::delivery::DeliveryBackendFuture<'a, crate::delivery::SettleStatus> {
        Box::pin(async {
            crate::delivery::SettleStatus::HandedOver(crate::delivery::HandoverState::HandedOver)
        })
    }
}

/// Releasing an agent that still owes a handed-over native delivery must dead
/// letter it IN DOUBT, not as a freely redeliverable failure.
///
/// The four worker-teardown sites (agent release over the HTTP API and over
/// Relaycast, permanent worker death, unsupervised worker exit) all funnel into
/// `dispose_pending_deliveries_for_teardown`. Before this they dead-lettered
/// with a bare reason string, so `is_auto_redeliverable` answered true. That was
/// sound while every route was a PTY child that died with the worker. A
/// `codex queue` message is a row in Codex's own durable store and the session
/// outlives both the worker and the broker, so re-sending it is the double
/// delivery seam rule 2 forbids.
///
/// The unsent control in the same test is what makes the assertion mean
/// something: a disposal path that marked EVERYTHING in doubt would pass the
/// first half and fail the second.
#[tokio::test]
async fn releasing_an_agent_with_a_handed_over_native_delivery_dead_letters_it_in_doubt() {
    let worker_name = "codex-attached";
    let handed_over_id = DeliveryId::new("del_released_handed_over");
    let never_sent_id = DeliveryId::new("del_released_never_sent");

    let mut seam = crate::delivery::DeliverySeam::new();
    let mut route = HandedOverNativeRoute {
        route: "codex-queue:thread-released",
    };
    let mut handed_over = make_pending_delivery(handed_over_id.as_str(), worker_name);
    handed_over.withheld_fleet_ack = Some(withheld_ack_for(handed_over_id.as_str()));
    seam.send(
        &mut [&mut route],
        crate::delivery::SendRequest::relay(
            WorkerName::from(worker_name),
            handed_over.delivery.clone(),
        ),
    )
    .await
    .expect("precondition: the native hand-off is recorded");
    assert!(
        seam.was_sent(&handed_over_id),
        "precondition: the seam must remember handing this to a transport"
    );

    let never_sent = make_pending_delivery(never_sent_id.as_str(), worker_name);
    let mut pending_deliveries = HashMap::from([
        (handed_over_id.clone(), handed_over),
        (never_sent_id.clone(), never_sent),
    ]);

    // The same removal every release / reap site performs.
    let dropped = take_pending_for_worker(&mut pending_deliveries, worker_name);
    assert_eq!(dropped.len(), 2, "both deliveries are torn down together");

    let (sdk_out_tx, _sdk_out_rx) = mpsc::channel(16);
    let mut dead_letters = DeadLetterStore::default();
    let probe = crate::node_delivery_probe::NodeDeliveryProbe::new();
    super::delivery::dispose_pending_deliveries_for_teardown(
        &sdk_out_tx,
        &mut dead_letters,
        &seam,
        &probe,
        &dropped,
        "agent_released",
    )
    .await
    .expect("teardown disposal is infallible");

    let handed = dead_letters
        .get(handed_over_id.as_str())
        .expect("a released delivery must stay operator-visible");
    assert!(
        handed
            .reason
            .starts_with(crate::runtime::dead_letter::IN_DOUBT_REASON_PREFIX),
        "a delivery already handed to a durable native route must be dead-lettered in doubt, got {}",
        handed.reason
    );
    assert!(
        !crate::runtime::dead_letter::is_auto_redeliverable(&handed.reason),
        "an in-doubt native delivery must never be auto-redelivered: {}",
        handed.reason
    );
    assert!(
        handed.reason.contains("codex-queue:thread-released"),
        "the dead letter must name the route that has the message: {}",
        handed.reason
    );
    assert_eq!(
        probe.snapshot_with_token(true)["dispositions"]["dropped_in_doubt"],
        serde_json::json!(1),
        "the withheld fleet ack's fate must be recorded, not dropped with a log line"
    );

    let unsent = dead_letters
        .get(never_sent_id.as_str())
        .expect("the control delivery must also be recorded");
    assert!(
        !unsent
            .reason
            .starts_with(crate::runtime::dead_letter::IN_DOUBT_REASON_PREFIX),
        "a delivery no transport ever saw must stay redeliverable, got {}",
        unsent.reason
    );
    assert!(
        crate::runtime::dead_letter::is_auto_redeliverable(&unsent.reason),
        "control: an un-sent delivery is still safe to redeliver: {}",
        unsent.reason
    );
}

/// Every worker-teardown site must dispose through the seam-aware path.
///
/// The in-doubt classification lives in
/// `dispose_pending_deliveries_for_teardown`; a site that keeps calling
/// `emit_dropped_delivery_failures` directly after `take_pending_for_worker`
/// re-opens the same hole for its own path only, which is exactly how this
/// started — one disposal site consulted the seam and four did not.
#[test]
fn every_worker_teardown_site_disposes_through_the_seam_aware_path() {
    for (file, source) in [
        ("api.rs", include_str!("api.rs")),
        ("relaycast_events.rs", include_str!("relaycast_events.rs")),
        ("maintenance.rs", include_str!("maintenance.rs")),
    ] {
        let sites = source.matches("take_pending_for_worker(").count();
        assert!(
            sites > 0,
            "{file} is declared a worker-teardown site but no longer removes pending deliveries"
        );
        assert_eq!(
            source
                .matches("dispose_pending_deliveries_for_teardown(")
                .count(),
            sites,
            "{file} removes pending deliveries at {sites} site(s) but does not dispose all of \
             them through the seam-aware path"
        );
        assert!(
            !source.contains("emit_dropped_delivery_failures("),
            "{file} must not bypass the seam-aware teardown disposal"
        );
    }
}

/// A broker restart must not queue a landed native delivery a second time.
///
/// Driven end to end through the real backend: a fake `codex` on disk records
/// every invocation, so "the backend was not invoked again" is observed from
/// the transport's own side rather than from a mock's bookkeeping. Lifetime one
/// hands the message over and snapshots the pending map; lifetime two loads
/// that snapshot into a brand-new `DeliverySeam` — the empty-at-startup state
/// that made a reloaded delivery classify `Fresh` — and runs the same retry the
/// first maintenance tick runs.
#[cfg(unix)]
#[tokio::test]
async fn a_restarted_broker_does_not_queue_a_handed_over_codex_delivery_again() {
    use std::os::unix::fs::PermissionsExt;

    let script_dir = tempfile::tempdir().expect("fake codex dir");
    let invocations = script_dir.path().join("invocations.log");
    let codex = script_dir.path().join("codex");
    std::fs::write(
        &codex,
        format!(
            r#"#!/bin/sh
if [ "$1" = "queue" ] && [ "$2" = "--help" ]; then
  printf '%s\n' 'Usage: codex queue --thread <id> --message=<text>'
  exit 0
fi
printf '%s\n' "$*" >> '{}'
exit 0
"#,
            invocations.display()
        ),
    )
    .expect("write fake codex");
    let mut permissions = std::fs::metadata(&codex).expect("metadata").permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&codex, permissions).expect("chmod");
    let queue_writes = || {
        std::fs::read_to_string(&invocations)
            .map(|log| log.lines().filter(|line| line.contains("queue ")).count())
            .unwrap_or(0)
    };

    let worker_name = "codex-restart";
    let delivery_id = DeliveryId::new("del_codex_restart");
    let mut workers = make_worker_registry_with_worker(worker_name).await;
    {
        let handle = workers
            .workers
            .get_mut(worker_name)
            .expect("fixture worker");
        handle.spec.runtime = AgentRuntime::Headless;
        handle.spec.cli = Some(codex.display().to_string());
        handle.spec.session_id = Some("thread-restart".to_string());
    }

    // --- broker lifetime one -------------------------------------------------
    let mut seam = crate::delivery::DeliverySeam::new();
    let mut pending_deliveries = HashMap::from([(delivery_id.clone(), {
        let mut pending = make_pending_delivery(delivery_id.as_str(), worker_name);
        pending.next_retry_at = Instant::now();
        pending
    })]);
    let outcome = retry_pending_delivery(
        &delivery_id,
        &mut workers,
        &mut pending_deliveries,
        Duration::from_secs(5),
        &mut seam,
    )
    .await
    .expect("the first hand-off must not error");
    assert!(
        matches!(outcome, DeliveryAttemptOutcome::Attempted { .. }),
        "the codex queue route must accept the first send, got {outcome:?}"
    );
    assert_eq!(queue_writes(), 1, "exactly one `codex queue` write so far");
    assert_eq!(
        pending_deliveries
            .get(&delivery_id)
            .and_then(|pending| pending.sent_route.as_ref())
            .and_then(super::delivery::PersistedDeliveryRoute::route),
        Some("codex-queue:thread-restart"),
        "the snapshot must carry the route, or the restart has nothing to restore from"
    );

    let snapshot_dir = tempfile::tempdir().expect("snapshot dir");
    let snapshot = snapshot_dir.path().join("pending-deliveries.json");
    super::delivery::save_pending_deliveries(&snapshot, &pending_deliveries)
        .expect("persist the pending snapshot");

    // --- broker lifetime two -------------------------------------------------
    // Exactly what `init.rs` does: load the snapshot, then re-seed a brand-new
    // seam from it before the first maintenance tick.
    let mut reloaded = super::delivery::load_pending_deliveries(&snapshot);
    assert!(
        reloaded.contains_key(&delivery_id),
        "precondition: the delivery survives the restart"
    );
    let mut restarted_seam = crate::delivery::DeliverySeam::new();
    assert_eq!(
        super::delivery::rehydrate_delivery_seam(&mut restarted_seam, &reloaded),
        1,
        "the reloaded native receipt must be restored into the new seam"
    );

    let restarted_outcome = retry_pending_delivery(
        &delivery_id,
        &mut workers,
        &mut reloaded,
        Duration::from_secs(5),
        &mut restarted_seam,
    )
    .await
    .expect("the post-restart tick must not error");

    assert_eq!(
        queue_writes(),
        1,
        "a delivery already sitting in Codex's durable queue must not be queued again \
         after a restart, got {restarted_outcome:?}"
    );
    assert!(
        matches!(restarted_outcome, DeliveryAttemptOutcome::Noop),
        "the restored receipt must answer AlreadySent and back off, got {restarted_outcome:?}"
    );

    cleanup_worker_registry(workers).await;
}

/// Build a registry whose only delivery target for `name` is an attached Codex
/// thread — no broker-owned worker process, which is the whole point of the
/// native route.
fn registry_with_attached_codex(name: &str) -> (WorkerRegistry, tempfile::NamedTempFile) {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let mut registry = WorkerRegistry::new(
        tx,
        Vec::new(),
        PathBuf::from("/tmp/agent-relay-broker-tests"),
        Instant::now(),
    );
    let rollout = tempfile::NamedTempFile::new().expect("rollout file");
    let target = crate::delivery::codex_queue::CodexQueueTarget::new_for_test(
        "codex",
        Vec::new(),
        None,
        "thread-attached",
        Some(rollout.path().to_path_buf()),
    );
    registry
        .attach_native_codex(WorkerName::from(name), target)
        .expect("attach the native Codex target");
    (registry, rollout)
}

/// `has_delivery_target` was widened to accept native Codex targets, which let
/// an inbound message for an attached Codex session be PARKED in manual flush.
/// The manual-flush drain is `try_inject_pending_relay_message_once` →
/// `WorkerRegistry::deliver`, which knows only broker-owned workers: it refuses
/// pre-write for a native target, the flush loop breaks, and the message stays
/// at the head of the FIFO forever, blocking everything queued behind it.
///
/// A native-only target must therefore never park. The PTY control in the same
/// test keeps manual flush working where it means something.
#[tokio::test]
async fn a_native_only_delivery_target_never_parks_an_inbound_message() {
    let worker_name = "codex-attached-flush";
    let (workers, _rollout) = registry_with_attached_codex(worker_name);
    let mut delivery_states: HashMap<WorkerName, InboundDeliveryState> = HashMap::from([(
        WorkerName::from(worker_name),
        InboundDeliveryState::new(crate::types::InboundDeliveryMode::ManualFlush),
    )]);

    let result = super::delivery::queue_inbound_for_delivery_mode(
        &mut delivery_states,
        &workers,
        worker_name,
        super::delivery::InboundContext {
            from: "Lead",
            body: "hello codex",
            target: worker_name,
            thread_id: None,
            workspace_id: None,
            workspace_alias: None,
            priority: 2,
            mode: MessageInjectionMode::Wait,
            event_id: Some("evt_native_flush"),
            relaycast_receipt: None,
        },
    );

    let InboundQueueOutcome::DrainNow(to_drain) = result.outcome else {
        panic!(
            "a message parked for a native-only target can never be flushed, got {:?}",
            result.outcome
        );
    };
    assert_eq!(
        to_drain.len(),
        1,
        "the message must be handed to the seam-backed drain"
    );
    assert_eq!(
        delivery_states
            .get(worker_name)
            .map(InboundDeliveryState::pending_len),
        Some(0),
        "nothing may be left parked behind it"
    );

    // Control: a broker-owned PTY worker still honours manual flush, so the
    // assertion above is about the native route and not about the mode being
    // ignored everywhere.
    let pty_name = "pty-manual-flush";
    let pty_workers = make_worker_registry_with_worker(pty_name).await;
    let mut pty_states: HashMap<WorkerName, InboundDeliveryState> = HashMap::from([(
        WorkerName::from(pty_name),
        InboundDeliveryState::new(crate::types::InboundDeliveryMode::ManualFlush),
    )]);
    let pty_result = super::delivery::queue_inbound_for_delivery_mode(
        &mut pty_states,
        &pty_workers,
        pty_name,
        super::delivery::InboundContext {
            from: "Lead",
            body: "hello pty",
            target: pty_name,
            thread_id: None,
            workspace_id: None,
            workspace_alias: None,
            priority: 2,
            mode: MessageInjectionMode::Wait,
            event_id: Some("evt_pty_flush"),
            relaycast_receipt: None,
        },
    );
    assert_eq!(
        pty_result.outcome,
        InboundQueueOutcome::Queued,
        "control: manual flush must still hold a PTY worker's inbound messages"
    );
    cleanup_worker_registry(pty_workers).await;
}

/// The other half of the same guarantee: manual flush is refused for a
/// native-only target at the setter, so the mode a message could be parked
/// under cannot be reached in the first place.
#[tokio::test]
async fn manual_flush_is_refused_for_a_native_only_delivery_target() {
    let worker_name = "codex-attached-mode";
    let (workers, _rollout) = registry_with_attached_codex(worker_name);
    let mut fixture = worker_event_runtime_fixture(workers, HashMap::new());

    let (reply, rx) = tokio::sync::oneshot::channel();
    fixture
        .runtime
        .handle_api_request(ListenApiRequest::SetInboundDeliveryMode {
            name: WorkerName::from(worker_name),
            mode: crate::types::InboundDeliveryMode::ManualFlush,
            expected_mode: None,
            expected_revision: None,
            reply,
        })
        .await;

    let error = rx
        .await
        .expect("the handler must answer")
        .expect_err("manual flush must be refused for a native-only delivery target");
    assert!(
        matches!(
            error,
            crate::listen_api::DeliveryRouteError::ManualFlushUnsupportedForNativeRoute(_)
        ),
        "the refusal must name its reason rather than pretend the agent does not exist, got {error}"
    );
    assert!(
        !fixture
            .runtime
            .delivery_states
            .get(worker_name)
            .is_some_and(|state| state.mode == crate::types::InboundDeliveryMode::ManualFlush),
        "a refused transition must not leave the worker in manual flush"
    );

    cleanup_worker_registry(fixture.runtime.workers).await;
}
