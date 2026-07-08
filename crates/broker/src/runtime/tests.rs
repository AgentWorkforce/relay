use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::ids::{
    AgentId, ChannelName, DeliveryId, EventId, MessageTarget, WorkerName, WorkspaceAlias,
    WorkspaceId,
};
use crate::protocol::{
    AgentSpec, BrokerEvent, DeliveryReadAckStatus, HarnessReleasePolicy, HeadlessHarnessConfig,
    HeadlessHarnessDriver, MessageInjectionMode, RelayDelivery, ResolvedHarnessConfig,
};
use crate::worker::{AgentWorkState, WorkerEvent, WorkerHandle, WorkerRegistry};
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
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::{
    apply_exit_after_task_instruction, build_agent_state_transition_event,
    build_http_api_spawn_spec, build_thread_infos, channels_from_csv,
    clear_pending_delivery_if_event_matches, continuity_dir, default_observer_token_scopes,
    delivery_read_ack_is_relaycast_message, delivery_retry_interval, drop_pending_for_worker,
    emit_delivery_attempt_outcome, emit_dropped_delivery_failures, ensure_ephemeral_paths,
    extract_mcp_message_ids, http_api_event_emit_timeout, http_api_local_delivery_timeout,
    http_api_relaycast_send_timeout, is_relaycast_self_control_target,
    is_unknown_worker_error_message, load_pending_deliveries, mark_delivery_read_ack,
    mark_delivery_read_ack_with_timeout, normalize_channel, normalize_initial_task,
    normalize_sender, parse_sort_key_from_raw_timestamp, persist_pending_on_shutdown,
    queue_inbound_for_delivery_mode, relaycast_spawn_control_dedup_key,
    relaycast_ws_should_apply_local_spawn_echo_dedup, relaycast_ws_spawn_token, resolve_workspace,
    retry_pending_delivery, seed_supplied_agent_token, send_broker_event,
    sender_is_dashboard_label, should_clear_pending_delivery_for_event,
    synthetic_delivery_read_ack_reason, AgentRuntime, DeliveryAttemptOutcome, InboundContext,
    InboundQueueOutcome, PendingDelivery, PendingDeliveryStore, ProtocolHeadlessProvider,
    RelayWorkspace, MAX_DELIVERY_RETRIES,
};
use crate::dedup::DedupCache;
use crate::relaycast::{
    format_worker_preregistration_error, RelaycastHttpClient, RelaycastRegistrationError, WsControl,
};
use crate::types::{InboundDeliveryMode, InboundDeliveryState};
use relaycast::ObserverScope;

fn env_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

async fn make_worker_registry_with_worker(name: &str) -> WorkerRegistry {
    let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
    let mut registry = WorkerRegistry::new(
        tx,
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
    registry.workers.insert(
        WorkerName::from(name),
        WorkerHandle {
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
            stdin,
            harness_pid: None,
            spawned_at: Instant::now(),
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
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: None,
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
async fn inbound_queue_eviction_surfaces_dropped_message() {
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

    let result = queue_inbound_for_delivery_mode(
        &mut delivery_states,
        &workers,
        worker_name,
        inbound_ctx("evt_overflow"),
    );

    assert_eq!(result.outcome, InboundQueueOutcome::Queued);
    assert_eq!(
        result.evicted_from.as_deref(),
        Some("Alice"),
        "hitting the per-worker cap must surface the evicted sender so callers can emit delivery_dropped"
    );
    assert_eq!(
        delivery_states
            .get(worker_name)
            .expect("state should exist")
            .pending_snapshot()
            .len(),
        crate::types::MAX_PENDING_PER_WORKER,
        "queue stays at the cap after eviction"
    );

    cleanup_worker_registry(workers).await;
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
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: None,
    }
}

#[test]
fn shutdown_persists_nonempty_pending_deliveries() {
    let dir = tempfile::tempdir().expect("tempdir should create");
    let path = dir.path().join("pending-deliveries.json");
    let deliveries = HashMap::from([(
        DeliveryId::new("del_keep"),
        make_pending_delivery("del_keep", "worker-a"),
    )]);

    persist_pending_on_shutdown(&path, true, &deliveries);

    let reloaded = load_pending_deliveries(&path);
    assert_eq!(reloaded.len(), 1, "pending delivery survives shutdown");
    let pending = reloaded
        .get("del_keep")
        .expect("persisted delivery should reload by id");
    assert_eq!(pending.worker_name, WorkerName::from("worker-a"));
    assert_eq!(pending.delivery.event_id, EventId::new("evt_del_keep"));
    assert_eq!(pending.attempts, 1);
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
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: Some("failed writing frame".to_string()),
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

    assert_eq!(
        outcome,
        DeliveryAttemptOutcome::Failed {
            worker_name: WorkerName::from("ghost"),
            delivery_id: DeliveryId::new("del_gone"),
            event_id: EventId::new("evt_gone"),
            from: "Lead".to_string(),
            to: MessageTarget::new("Worker"),
            attempts: 3,
            last_error: "recipient gone".to_string(),
        }
    );
    assert!(
        pending_deliveries.is_empty(),
        "terminal failed deliveries are removed so they cannot retry forever"
    );
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
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
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
            Ok(outcome @ DeliveryAttemptOutcome::Failed { attempts, .. }) => {
                assert_eq!(attempts, MAX_DELIVERY_RETRIES);
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
    emit_delivery_attempt_outcome(&sdk_out_tx, &DeliveryId::new("del_blip"), true, outcome)
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
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: Some("old transient failure".to_string()),
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
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
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
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
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
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: Some("previous blip".to_string()),
    };
    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel(4);

    emit_dropped_delivery_failures(&sdk_out_tx, &[pending], "worker_permanently_dead")
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
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: None,
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
            next_retry_at: Instant::now(),
            queued_at_ms: super::unix_timestamp_millis(),
            last_error: None,
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
        next_retry_at: Instant::now(),
        queued_at_ms: super::unix_timestamp_millis(),
        last_error: None,
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
    ]
    .into_iter()
    .collect();

    assert_eq!(
        scopes.len(),
        7,
        "expected exactly 7 default observer token scopes, got {scopes:?}"
    );
    assert_eq!(
        actual, expected,
        "default observer token scopes must be exactly the minimal read-only set"
    );
}
