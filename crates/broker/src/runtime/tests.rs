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
use crate::node_control::{FleetControlCommand, FleetDeliveryBook};
use crate::protocol::{
    AgentSpec, BrokerEvent, DeliveryReadAckStatus, HarnessReleasePolicy, HeadlessHarnessConfig,
    HeadlessHarnessDriver, MessageInjectionMode, NativeHarnessConfig, ProtocolEnvelope,
    RelayDelivery, ResolvedHarnessConfig,
};
use crate::telemetry::TelemetryClient;
use crate::worker::{
    spawn_worker_writer, AgentWorkState, WorkerEvent, WorkerHandle, WorkerRegistry,
};
use crate::{
    broker::injection_format::format_injection,
    util::{
        ansi::{floor_char_boundary, strip_ansi},
        terminal::{
            claude_trust_prompt_action, detect_bypass_permissions_prompt,
            detect_claude_trust_prompt, is_auto_suggestion, is_bypass_selection_menu,
            is_in_editor_mode, ClaudeTrustPromptAction,
        },
    },
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::api::recipient_name_for_reachability;
use super::{
    apply_exit_after_task_instruction, build_agent_state_transition_event,
    build_http_api_spawn_spec, build_thread_infos, channels_from_csv,
    clear_pending_delivery_if_event_matches, continuity_dir, default_observer_token_scopes,
    delivery_read_ack_is_relaycast_message, delivery_retry_interval, drop_pending_for_worker,
    emit_delivery_attempt_outcome, emit_dropped_delivery_failures, ensure_ephemeral_paths,
    extract_mcp_message_ids, http_api_event_emit_timeout, http_api_local_delivery_timeout,
    http_api_relaycast_send_timeout, is_relaycast_self_control_target,
    is_unknown_worker_error_message, load_dead_letters, load_pending_deliveries,
    mark_delivery_read_ack, mark_delivery_read_ack_with_timeout, mint_or_recover_observer_token,
    normalize_channel, normalize_initial_task, normalize_sender, parse_sort_key_from_raw_timestamp,
    pending_message_counts, persist_dead_letters_on_shutdown, persist_pending_on_shutdown,
    queue_inbound_for_delivery_mode, relaycast_spawn_control_dedup_key,
    relaycast_ws_should_apply_local_spawn_echo_dedup, relaycast_ws_spawn_token,
    requeue_dead_letter, resolve_exit_after_task, resolve_workspace, retry_pending_delivery,
    save_dead_letters, seed_supplied_agent_token, send_broker_event, sender_is_dashboard_label,
    should_clear_pending_delivery_for_event, synthetic_delivery_read_ack_reason,
    take_pending_for_worker, try_inject_pending_relay_message, AgentRuntime, BrokerRuntime,
    DeadLetterEntry, DeadLetterStore, DeliveryAttemptOutcome, InboundContext, InboundQueueOutcome,
    ObserverTokenMintError, ObserverTokenMintOutcome, PendingDelivery, PendingDeliveryStore,
    ProtocolHeadlessProvider, RelayWorkspace, RuntimePaths, TypedThreadMessage, MAX_DEAD_LETTERS,
    MAX_DELIVERY_RETRIES,
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
    fleet_control_rx: mpsc::Receiver<FleetControlCommand>,
    _sdk_out_rx: mpsc::Receiver<ProtocolEnvelope<Value>>,
    _temp_dir: tempfile::TempDir,
}

fn worker_event_runtime_fixture(
    workers: WorkerRegistry,
    pending_deliveries: HashMap<DeliveryId, PendingDelivery>,
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
    let default_workspace = test_relay_workspace("ws_demo", Some("demo"));
    let default_workspace_id = Some(default_workspace.workspace_id.clone());
    let workspace_lookup = HashMap::from([(
        default_workspace.workspace_id.clone(),
        default_workspace.clone(),
    )]);
    let self_names = default_workspace.self_names.clone();
    let ws_control_tx = default_workspace.ws_control_tx.clone();
    let relaycast_http = default_workspace.http_client.clone();
    let (_api_tx, api_rx) = mpsc::channel(4);
    let (_ws_inbound_tx, ws_inbound_rx) = mpsc::channel(4);
    let (fleet_control_tx, fleet_control_rx) = mpsc::channel(16);
    let (_fleet_event_tx, fleet_event_rx) = mpsc::channel(4);
    let (terminal_control_tx, _terminal_control_rx) = mpsc::channel(4);
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
        node_delivery_connected: true,
        fleet_event_rx,
        fleet_control_open: true,
        terminal_control_tx,
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
        dead_letters: DeadLetterStore::default(),
        terminal_failed_deliveries: HashSet::new(),
        pending_requests: HashMap::new(),
        pending_verified_spawns: HashMap::new(),
        resize_owners: HashMap::new(),
        delivery_states: HashMap::new(),
        agent_result_tokens: HashMap::new(),
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

    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(16);
    let _ = &mut sdk_out_rx;
    let mut dead_letters = DeadLetterStore::new(Vec::new());
    let mut obligation_store = crate::obligation::ObligationStore::default();
    let result = super::fleet::flush_pending_relay_messages(
        &mut delivery_states,
        &mut workers,
        &mut delivery_book,
        &fleet_control_tx,
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
    for expected_seq in [1, 2] {
        match fleet_control_rx.recv().await {
            Some(FleetControlCommand::Send(BrokerToRelaycast::DeliveryAck(ack))) => {
                assert_eq!(ack.agent, worker_name);
                assert_eq!(ack.up_to_seq, expected_seq);
            }
            other => panic!("expected delivery ACK {expected_seq}, got {other:?}"),
        }
    }
    assert!(fleet_control_rx.try_recv().is_err());

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
                Duration::from_millis(1)
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
                Duration::from_millis(1)
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
    assert_eq!(delivery_states[&worker_name].pending_snapshot(), expected);
    assert_eq!(delivery_book.acked_up_to_seq("agent-worker-a"), 0);
    assert!(fleet_control_rx.try_recv().is_err());

    cleanup_worker_registry(workers).await;
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
    )
    .await;
    assert!(first_attempt.is_err());
    let missing_outcome = retry_pending_delivery(
        &missing_id,
        &mut fixture.runtime.workers,
        &mut fixture.runtime.pending_deliveries,
        Duration::from_millis(1),
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

// relay#1310 MUST-NOT-FIRE: once the worker confirms the injection landed
// (echo-verified, or its bounded timeout fallback — pty_worker.rs sends the
// same internal `delivery_ack` event either way), the engine ack must still
// fire, with the delivery's own (agent, up_to_seq) — i.e. the happy path is
// unchanged, just correctly gated on confirmation instead of write-enqueue.
// Exercises the full wiring: a real handoff through
// `try_inject_pending_relay_message`, followed by a matching worker event
// through `BrokerRuntime::handle_worker_event`, with the assertion made on the
// fleet-control receiver rather than on an extracted helper's return value.
#[tokio::test]
async fn successful_injection_still_resolves_its_withheld_fleet_ack() {
    let worker_name = "worker-a";
    let registry = make_worker_registry_with_worker(worker_name).await;
    let generation = registry.workers[worker_name].generation;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
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
    )
    .await
    .expect("a registered worker should accept the handoff");

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

    match tokio::time::timeout(Duration::from_secs(1), fixture.fleet_control_rx.recv()).await {
        Ok(Some(FleetControlCommand::Send(BrokerToRelaycast::DeliveryAck(ack)))) => {
            assert_eq!(ack.agent, deliver.agent);
            assert_eq!(ack.up_to_seq, deliver.seq);
        }
        other => {
            panic!("expected worker confirmation to emit the withheld fleet ack, got {other:?}")
        }
    }
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    assert!(!fixture
        .runtime
        .pending_deliveries
        .contains_key(&delivery_id));

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
        },
    )]);

    let outcome = retry_pending_delivery(
        &DeliveryId::new("del_gone"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
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
}

#[tokio::test]
async fn delivery_retry_transient_blip_emits_failed_event_for_present_worker() {
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
        },
    )]);

    let mut final_outcome = None;
    for retry_index in 1..=MAX_DELIVERY_RETRIES + 1 {
        match retry_pending_delivery(
            &DeliveryId::new("del_blip"),
            &mut workers,
            &mut pending_deliveries,
            Duration::from_millis(1),
        )
        .await
        {
            Ok(outcome @ DeliveryAttemptOutcome::Failed { .. }) => {
                let DeliveryAttemptOutcome::Failed { ref pending, .. } = outcome else {
                    unreachable!();
                };
                assert_eq!(pending.attempts, MAX_DELIVERY_RETRIES);
                // Some platforms can accept a final pipe write after the child exits,
                // so terminal failure may arrive on the immediate post-cap check.
                assert!(
                    retry_index >= MAX_DELIVERY_RETRIES,
                    "delivery should not fail before the retry cap is exhausted"
                );
                final_outcome = Some(outcome);
                break;
            }
            Ok(DeliveryAttemptOutcome::Attempted { attempts, .. }) => {
                assert!(
                    attempts <= MAX_DELIVERY_RETRIES,
                    "retry attempts must stay within the retry cap"
                );
                assert!(
                    retry_index <= MAX_DELIVERY_RETRIES,
                    "the retry after the cap should return a terminal failure"
                );
            }
            Ok(DeliveryAttemptOutcome::Noop) => {
                assert!(
                    retry_index < MAX_DELIVERY_RETRIES,
                    "the final bounded retry should return a terminal failure"
                );
                let pending = pending_deliveries
                    .get("del_blip")
                    .expect("delivery remains pending before terminal failure");
                assert_eq!(pending.attempts, retry_index);
                assert!(pending
                    .last_error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("failed writing frame to worker 'worker-blip'"));
            }
            Err(error) => panic!("transient delivery write errors should stay queued: {error}"),
        }
    }

    let outcome = final_outcome.expect("present worker write blip must terminate as failed");
    assert!(
        pending_deliveries.is_empty(),
        "terminal failed deliveries are removed so they cannot stall silently"
    );

    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(4);
    let mut dead_letters = DeadLetterStore::default();
    emit_delivery_attempt_outcome(
        &sdk_out_tx,
        &mut dead_letters,
        &DeliveryId::new("del_blip"),
        true,
        outcome,
    )
    .await
    .expect("failed outcome should emit to sdk_out_tx");

    let frame = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv())
        .await
        .expect("orchestrator should receive delivery failure event promptly")
        .expect("sdk_out_tx should remain open");
    assert_eq!(frame.msg_type, "event");
    assert_eq!(frame.payload["kind"], "message_delivery_failed");
    assert_eq!(frame.payload["name"], worker_name);
    assert_eq!(frame.payload["delivery_id"], "del_blip");
    assert_eq!(frame.payload["event_id"], "evt_blip");
    assert_eq!(frame.payload["from"], "orchestrator");
    assert_eq!(frame.payload["to"], worker_name);
    assert_eq!(
        frame.payload["attempts"].as_u64(),
        Some(u64::from(MAX_DELIVERY_RETRIES))
    );
    let last_error = frame.payload["lastError"].as_str().unwrap_or_default();
    assert!(
        last_error.contains("failed writing frame to worker 'worker-blip'")
            || last_error.contains("max delivery retries exceeded")
    );
    assert!(
        frame.payload.get("last_error").is_none(),
        "wire event should use the typed lastError field only"
    );

    let dead_frame = tokio::time::timeout(Duration::from_secs(1), sdk_out_rx.recv())
        .await
        .expect("terminal failure should also emit dead_letter_added")
        .expect("sdk_out_tx should remain open");
    assert_eq!(dead_frame.payload["kind"], "dead_letter_added");
    assert_eq!(dead_frame.payload["delivery_id"], "del_blip");
    assert_eq!(
        dead_letters.len(),
        1,
        "terminal failure is retained in the dead-letter store, not discarded"
    );
    let entry = dead_letters.get("del_blip").expect("dead letter by id");
    assert_eq!(entry.delivery.body, "transient auth blip");
    assert_eq!(entry.attempts, MAX_DELIVERY_RETRIES);
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
        },
    )]);

    let outcome = retry_pending_delivery(
        &DeliveryId::new("del_clear"),
        &mut workers,
        &mut pending_deliveries,
        Duration::from_millis(1),
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
fn contract_timeout_fixture_requires_terminal_failed_guard_before_late_ack() {
    let replay_fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/replay-fixtures.json"
    ))
    .expect("replay fixture should be valid JSON");
    let timeout_fixture = replay_fixture
        .get("wave0_timeout_terminal_semantics")
        .and_then(Value::as_object)
        .expect("replay fixture must include wave0_timeout_terminal_semantics object");

    let expected_terminal_status = timeout_fixture
        .get("expected_terminal_status")
        .and_then(Value::as_str)
        .expect("timeout fixture requires expected_terminal_status");
    let late_event_kind = timeout_fixture
        .get("late_event_kind")
        .and_then(Value::as_str)
        .expect("timeout fixture requires late_event_kind");

    let source = include_str!("worker_events.rs");
    let ack_branch = source
        .find("msg_type == \"delivery_ack\"")
        .map(|idx| {
            let end = (idx + 1200).min(source.len());
            &source[idx..end]
        })
        .expect("worker_events.rs must include delivery_ack handling");

    assert!(
        ack_branch.contains(expected_terminal_status) || ack_branch.contains("terminal"),
        "delivery_ack branch lacks terminal guard for timeout status \"{}\" and late event \"{}\"",
        expected_terminal_status,
        late_event_kind
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
    assert_eq!(
        claude_trust_prompt_action(output),
        Some(ClaudeTrustPromptAction::Confirm)
    );
}

#[test]
fn claude_trust_prompt_new_layout_moves_to_affirmative_row() {
    let output = "take a moment to review what's in this folder first.\n\
                       ❯ No, exit\n\
                         Yes, I trust this folder\n\
                       Enter to confirm · Esc to cancel";
    assert_eq!(
        claude_trust_prompt_action(output),
        Some(ClaudeTrustPromptAction::MoveDownAndConfirm)
    );
}

#[test]
fn claude_trust_prompt_stripped_spaces() {
    let output = "Yes,Itrustthisfolder\nNo,exit";
    let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
    assert!(has_trust_ref);
    assert!(has_confirmation);
    assert_eq!(
        claude_trust_prompt_action(output),
        None,
        "labels without rendered selection state must fail closed"
    );
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
fn claude_trust_prompt_ambiguous_selection_fails_closed() {
    let output = "❯ No, exit\n❯ Yes, I trust this folder";
    assert_eq!(claude_trust_prompt_action(output), None);
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
    let (ws_control_tx, _ws_control_rx) = mpsc::channel::<WsControl>(1);
    RelayWorkspace {
        workspace_id: WorkspaceId::from(workspace_id.to_string()),
        workspace_alias: workspace_alias.map(|alias| WorkspaceAlias::from(alias.to_string())),
        relay_workspace_key: "rk_live_test".to_string(),
        self_name: "broker".to_string(),
        self_agent_id: AgentId::from("agent_broker".to_string()),
        self_names: HashSet::from(["broker".to_string()]),
        self_agent_ids: HashSet::from([AgentId::from("agent_broker".to_string())]),
        http_client: RelaycastHttpClient::new(None, "rk_live_test", "broker", "codex"),
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
