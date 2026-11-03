use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const THREAD: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

struct Fake {
    path: PathBuf,
    owner: Mutex<Option<String>>,
    idle: AtomicBool,
    terminal: AtomicBool,
    conductor: AtomicBool,
    recorded: AtomicBool,
    peer_recorded: AtomicBool,
    queued_message: AtomicBool,
    hidden_message: AtomicBool,
    rollout: Mutex<Option<CodexConfig>>,
    queued: Mutex<Option<bool>>,
    result: Mutex<Result<bool, TurnError>>,
    native: Mutex<Vec<(String, String, String)>>,
    peer: AtomicUsize,
}

impl Fake {
    fn new(dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            path: dir.join("native"),
            owner: Mutex::new(Some("window-generation-1".into())),
            idle: AtomicBool::new(true),
            terminal: AtomicBool::new(false),
            conductor: AtomicBool::new(false),
            recorded: AtomicBool::new(false),
            peer_recorded: AtomicBool::new(false),
            queued_message: AtomicBool::new(false),
            hidden_message: AtomicBool::new(false),
            rollout: Mutex::new(None),
            queued: Mutex::new(Some(false)),
            result: Mutex::new(Ok(true)),
            native: Mutex::new(Vec::new()),
            peer: AtomicUsize::new(0),
        })
    }
}

impl CodexRoutes for Fake {
    fn native_receipts(&self) -> Option<PathBuf> {
        Some(self.path.clone())
    }
    fn native_recorded(&self, thread: &str, id: &str) -> bool {
        self.rollout.lock().unwrap().as_ref().map_or_else(
            || self.recorded.load(Ordering::SeqCst),
            |config| recorded(config, thread, id),
        )
    }
    fn native_window_owner(&self, _: &str) -> Option<String> {
        self.owner.lock().unwrap().clone()
    }
    fn native_window(
        &self,
        _: &str,
        text: &str,
        id: &str,
        owner: &str,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<bool, TurnError> {
        if !admit() {
            return Ok(false);
        }
        self.native
            .lock()
            .unwrap()
            .push((text.into(), id.into(), owner.into()));
        self.result.lock().unwrap().clone()
    }
    fn recorded(&self, thread: &str, reference: &str) -> bool {
        self.rollout.lock().unwrap().as_ref().map_or_else(
            || self.peer_recorded.load(Ordering::SeqCst),
            |config| rollout::recorded(config, thread, reference),
        )
    }
    fn hidden_waiting(&self, _: &str, _: &str) -> bool {
        self.hidden_message.load(Ordering::SeqCst)
    }
    fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
        self.queued
            .lock()
            .unwrap()
            .map(|_| self.queued_message.load(Ordering::SeqCst))
    }
    fn relay_waiting(&self, _: &str) -> Option<bool> {
        *self.queued.lock().unwrap()
    }
    fn idle(&self, _: &str) -> bool {
        self.idle.load(Ordering::SeqCst)
    }
    fn app_server(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
        self.peer.fetch_add(1, Ordering::SeqCst);
        Ok(true)
    }
    fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
        self.peer.fetch_add(1, Ordering::SeqCst);
        Ok(true)
    }
    fn terminal_live(&self, _: &str) -> bool {
        self.terminal.load(Ordering::SeqCst)
    }
    fn conductor_owned(&self, _: &str) -> bool {
        self.conductor.load(Ordering::SeqCst)
    }
    fn queue_send(&self, _: &str, _: &str) -> Result<(), QueueError> {
        self.peer.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn cleanup(&self, _: &str, _: &str) {}
}

#[test]
fn native_codex_capability_requires_a_live_window_not_a_terminal_or_conductor() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let router = CodexRouter::new(fake.clone());
    assert!(router.native_continuation(THREAD));
    assert!(!router.native_continuation("a session name"));
    fake.terminal.store(true, Ordering::SeqCst);
    assert!(!router.native_continuation(THREAD));
    fake.terminal.store(false, Ordering::SeqCst);
    fake.conductor.store(true, Ordering::SeqCst);
    assert!(!router.native_continuation(THREAD));
    fake.conductor.store(false, Ordering::SeqCst);
    *fake.owner.lock().unwrap() = None;
    assert!(!router.native_continuation(THREAD));
    assert!(
        !fake.path.exists(),
        "capability reads cannot claim a message"
    );
}

#[test]
fn native_codex_raw_turn_is_correlated_and_never_replayed_after_restart_or_optout() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let text = "Continue with the next test.";
    assert_eq!(
        CodexRouter::new(fake.clone()).inject_native_existing(THREAD, "mobile-1", text),
        InjectOutcome::Delivered
    );
    assert_eq!(
        *fake.native.lock().unwrap(),
        vec![(text.into(), "mobile-1".into(), "window-generation-1".into())]
    );
    let restarted = CodexRouter::new(fake.clone());
    assert_eq!(
        restarted.inject_native_existing(THREAD, "mobile-1", text),
        InjectOutcome::Delivered
    );
    assert_eq!(
        restarted.inject(THREAD, "mobile-1", "[via Agent Relay] changed framing"),
        InjectOutcome::Delivered
    );
    assert_eq!(fake.native.lock().unwrap().len(), 1);
    assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
    assert!(matches!(
        restarted.inject_native_existing(THREAD, "mobile-1", "changed text"),
        InjectOutcome::InDoubt(_)
    ));
}

#[test]
fn native_codex_busy_unsent_claim_cannot_later_become_a_peer_or_move_windows() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    fake.idle.store(false, Ordering::SeqCst);
    let router = CodexRouter::new(fake.clone());
    assert!(matches!(
        router.inject_native_existing(THREAD, "busy", "hello"),
        InjectOutcome::WaitingForTurn(_)
    ));
    fake.idle.store(true, Ordering::SeqCst);
    assert!(matches!(
        router.inject(THREAD, "busy", "peer text"),
        InjectOutcome::Refused(_)
    ));
    assert!(matches!(
        router.inject_native_existing(THREAD, "busy", "hello"),
        InjectOutcome::Refused(_)
    ));
    fake.idle.store(false, Ordering::SeqCst);
    assert!(matches!(
        router.inject_native_existing(THREAD, "window", "hello"),
        InjectOutcome::WaitingForTurn(_)
    ));
    *fake.owner.lock().unwrap() = Some("window-generation-2".into());
    fake.idle.store(true, Ordering::SeqCst);
    assert!(matches!(
        router.inject_native_existing(THREAD, "window", "hello"),
        InjectOutcome::Refused(_)
    ));
    assert!(fake.native.lock().unwrap().is_empty());
    assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
}

#[test]
fn native_codex_uncertain_send_only_observes_its_client_id_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    *fake.result.lock().unwrap() = Err(TurnError::InDoubt("lost response".into()));
    let router = CodexRouter::new(fake.clone());
    assert!(matches!(
        router.inject_native_existing(THREAD, "uncertain", "hello"),
        InjectOutcome::InDoubt(_)
    ));
    let restarted = CodexRouter::new(fake.clone());
    assert!(matches!(
        restarted.inject_native_existing(THREAD, "uncertain", "hello"),
        InjectOutcome::InDoubt(_)
    ));
    assert!(matches!(
        restarted.inject(THREAD, "uncertain", "peer"),
        InjectOutcome::InDoubt(_)
    ));
    assert_eq!(fake.native.lock().unwrap().len(), 1);
    fake.recorded.store(true, Ordering::SeqCst);
    assert_eq!(
        restarted.inject_native_existing(THREAD, "uncertain", "hello"),
        InjectOutcome::Delivered
    );
    assert_eq!(fake.native.lock().unwrap().len(), 1);
}

#[test]
fn native_codex_queue_wait_and_corrupt_receipts_never_fall_back_to_other_transports() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let router = CodexRouter::new(fake.clone());
    for queued in [Some(true), None] {
        *fake.queued.lock().unwrap() = queued;
        assert!(matches!(
            router.inject_native_existing(THREAD, "waiting", "hello"),
            InjectOutcome::Waiting(_)
        ));
    }
    std::fs::write(receipt_path(&fake.path, THREAD, "waiting"), "partial write").unwrap();
    assert!(matches!(
        router.inject_native_existing(THREAD, "waiting", "hello"),
        InjectOutcome::InDoubt(_)
    ));
    assert!(matches!(
        router.inject(THREAD, "waiting", "peer"),
        InjectOutcome::InDoubt(_)
    ));
    assert!(fake.native.lock().unwrap().is_empty());
    assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[test]
fn native_codex_wire_keeps_raw_input_and_existing_window_approval_policy() {
    use crate::relay::codex::ipc::tests::FakeRouter;
    use std::os::unix::net::UnixListener;
    let temp = tempfile::tempdir().unwrap();
    let socket = temp.path().join("router.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let started = Arc::new(Mutex::new(Vec::new()));
    let captured = started.clone();
    let server = std::thread::spawn(move || {
        // A stale generation must not start anything; the second connection
        // targets the live owner with exactly the native input and receipt ID.
        for _ in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            FakeRouter {
                owned: vec![THREAD.into()],
                refuse: None,
                started: captured.clone(),
            }
            .serve(stream);
        }
    });
    assert_eq!(
        hosts::window_native_turn(&socket, THREAD, "hello", "id-1", "replaced-owner", &|| true),
        Ok(false)
    );
    let text = "Please continue.\nKeep the current sandbox and model.";
    assert_eq!(
        hosts::window_native_turn(&socket, THREAD, text, "id-1", "owner-1", &|| true),
        Ok(true)
    );
    server.join().unwrap();
    let requests = started.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["targetClientId"], "owner-1");
    assert_eq!(
        requests[0]["params"],
        serde_json::json!({
            "conversationId": THREAD,
            "turnStart": {
                "context": {},
                "request": {
                    "threadId": THREAD,
                    "clientUserMessageId": "id-1",
                    "input": [{"type": "text", "text": text, "text_elements": []}]
                }
            }
        })
    );
}

#[test]
fn native_codex_invalid_input_creates_no_claim_and_thread_receipts_are_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let router = CodexRouter::new(fake.clone());
    for (thread, id, text) in [
        ("invalid", "id", "hello"),
        (THREAD, "", "hello"),
        (THREAD, "id", " \n"),
    ] {
        assert!(matches!(
            router.inject_native_existing(thread, id, text),
            InjectOutcome::Refused(_)
        ));
    }
    assert!(!fake.path.exists());
    assert_eq!(
        router.inject_native_existing(THREAD, "same-id", "one"),
        InjectOutcome::Delivered
    );
    assert_eq!(
        router.inject_native_existing("bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", "same-id", "two"),
        InjectOutcome::Delivered
    );
    assert_eq!(fake.native.lock().unwrap().len(), 2);
}

#[test]
fn native_codex_shards_bound_reads_and_reject_a_copied_receipt_scope() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let router = CodexRouter::new(fake.clone());
    assert_eq!(
        router.inject_native_existing(THREAD, "first", "hello"),
        InjectOutcome::Delivered
    );
    let first = receipt_path(&fake.path, THREAD, "first");
    let second = receipt_path(&fake.path, THREAD, "second");
    std::fs::copy(&first, &second).unwrap();
    assert!(matches!(
        router.inject_native_existing(THREAD, "second", "hello"),
        InjectOutcome::InDoubt(_)
    ));
    assert!(matches!(
        router.inject(THREAD, "second", "peer"),
        InjectOutcome::InDoubt(_)
    ));
    std::fs::write(&second, br#"{"entries":[]}"#).unwrap();
    assert!(matches!(
        router.inject(THREAD, "second", "peer"),
        InjectOutcome::InDoubt(_)
    ));
    std::fs::write(&second, vec![b' '; 16 * 1024 + 1]).unwrap();
    assert!(matches!(
        router.inject_native_existing(THREAD, "second", "hello"),
        InjectOutcome::InDoubt(_)
    ));
    assert_eq!(
        router.inject_native_existing(THREAD, "third", "hello"),
        InjectOutcome::Delivered
    );
    assert_eq!(
        fake.native.lock().unwrap().len(),
        2,
        "unrelated shards cannot block or alias this receipt"
    );
    assert!(first.exists(), "successful tombstones are retained");
}

#[test]
fn native_codex_simultaneous_attempts_send_once_across_router_instances() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let fake = fake.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                CodexRouter::new(fake).inject_native_existing(THREAD, "concurrent", "hello")
            })
        })
        .collect();
    for worker in workers {
        assert!(matches!(
            worker.join().unwrap(),
            InjectOutcome::Delivered | InjectOutcome::InDoubt(_)
        ));
    }
    assert_eq!(fake.native.lock().unwrap().len(), 1);
    assert_eq!(
        CodexRouter::new(fake).inject_native_existing(THREAD, "concurrent", "hello"),
        InjectOutcome::Delivered
    );
}

#[test]
fn native_codex_missing_initial_owner_cannot_bind_a_later_window() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    *fake.owner.lock().unwrap() = None;
    let router = CodexRouter::new(fake.clone());
    assert!(matches!(
        router.inject_native_existing(THREAD, "no-owner", "hello"),
        InjectOutcome::Refused(_)
    ));
    *fake.owner.lock().unwrap() = Some("new-window".into());
    assert!(matches!(
        router.inject_native_existing(THREAD, "no-owner", "hello"),
        InjectOutcome::Refused(_)
    ));
    assert!(fake.native.lock().unwrap().is_empty());
}

#[test]
fn native_codex_lost_response_reconciles_exact_client_id_from_real_rollout() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let config = CodexConfig {
        home: temp.path().join("codex"),
        sqlite_home: temp.path().join("codex"),
        executable: None,
        ipc_socket: temp.path().join("unused.sock"),
    };
    std::fs::create_dir_all(config.home.join("sessions")).unwrap();
    *fake.rollout.lock().unwrap() = Some(config.clone());
    *fake.result.lock().unwrap() = Err(TurnError::InDoubt("lost response".into()));
    let router = CodexRouter::new(fake.clone());
    assert!(matches!(
        router.inject_native_existing(THREAD, "exact-native-id", "Please continue"),
        InjectOutcome::InDoubt(_)
    ));
    let line = serde_json::json!({"type":"event_msg","payload":{
        "type":"item_completed","turn_id":"turn-native","item":{
            "type":"UserMessage","client_id":"exact-native-id",
            "content":[{"type":"text","text":"Please continue"}]
        }
    }});
    std::fs::write(
        config
            .home
            .join("sessions")
            .join(format!("rollout-test-{THREAD}.jsonl")),
        format!("{line}\n"),
    )
    .unwrap();
    assert!(
        !rollout::recorded(&config, THREAD, &MessageRef::of("exact-native-id")),
        "native text has no peer marker"
    );
    assert!(recorded(&config, THREAD, "exact-native-id"));
    assert!(!recorded(&config, THREAD, "different-id"));
    assert_eq!(
        router.inject_native_existing(THREAD, "exact-native-id", "Please continue"),
        InjectOutcome::Delivered
    );
    assert_eq!(
        CodexRouter::new(fake.clone()).inject(THREAD, "exact-native-id", "peer retry"),
        InjectOutcome::Delivered
    );
    assert_eq!(fake.native.lock().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn native_codex_dangling_receipt_or_lock_never_creates_a_second_turn() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let router = CodexRouter::new(fake.clone());
    for lock in [false, true] {
        let id = if lock { "bad-lock" } else { "bad-receipt" };
        assert_eq!(
            router.inject_native_existing(THREAD, id, "hello"),
            InjectOutcome::Delivered
        );
        let mut path = receipt_path(&fake.path, THREAD, id);
        if lock {
            path.set_extension("lock");
        }
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(temp.path().join("missing-target"), &path).unwrap();
        assert!(matches!(
            router.inject_native_existing(THREAD, id, "hello"),
            InjectOutcome::InDoubt(_)
        ));
        assert!(matches!(
            router.inject(THREAD, id, "peer"),
            InjectOutcome::InDoubt(_)
        ));
    }
    assert_eq!(fake.native.lock().unwrap().len(), 2);
    assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
}

#[test]
fn native_codex_late_authority_revocation_retains_refused_mode() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let router = CodexRouter::new(fake.clone());
    let checks = AtomicUsize::new(0);
    let admit = || checks.fetch_add(1, Ordering::SeqCst) == 0;
    assert!(matches!(
        router.inject_native_existing_guarded(THREAD, "revoked", "hello", &admit),
        InjectOutcome::Refused(_)
    ));
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    assert!(matches!(
        router.inject_native_existing(THREAD, "revoked", "hello"),
        InjectOutcome::Refused(_)
    ));
    assert!(matches!(
        router.inject(THREAD, "revoked", "peer"),
        InjectOutcome::Refused(_)
    ));
    assert!(fake.native.lock().unwrap().is_empty());
    assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[test]
fn native_codex_owner_discovery_wait_rechecks_authority_before_start_turn() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    let temp = tempfile::tempdir().unwrap();
    let socket = temp.path().join("router.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        for method in ["initialize", "thread-owner-discovery"] {
            let mut size = [0; 4];
            stream.read_exact(&mut size).unwrap();
            let mut body = vec![0; u32::from_le_bytes(size) as usize];
            stream.read_exact(&mut body).unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["method"], method);
            let mut response = serde_json::json!({"type":"response","requestId":request["requestId"],"resultType":"success"});
            if method == "initialize" {
                response["result"] = serde_json::json!({"clientId":"relay-test"});
            } else {
                ready_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                response["handledByClientId"] = "owner-1".into();
                response["result"] = serde_json::json!({"supportsUntrustedAppInput":true});
            }
            stream
                .write_all(&ipc::encode_frame(&serde_json::to_vec(&response).unwrap()).unwrap())
                .unwrap();
        }
        let mut byte = [0];
        assert_eq!(
            stream.read(&mut byte).unwrap(),
            0,
            "revoked owner must close without a start-turn request"
        );
    });
    let allowed = Arc::new(AtomicBool::new(true));
    let current = allowed.clone();
    let attempt = std::thread::spawn(move || {
        hosts::window_native_turn(&socket, THREAD, "hello", "held", "owner-1", &|| {
            current.load(Ordering::SeqCst)
        })
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    allowed.store(false, Ordering::SeqCst);
    release_tx.send(()).unwrap();
    assert_eq!(attempt.join().unwrap(), Ok(false));
    server.join().unwrap();
}

#[test]
fn native_retry_settles_original_marker_only_peer_rollout_without_another_turn() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    let config = CodexConfig {
        home: temp.path().join("codex"),
        sqlite_home: temp.path().join("codex"),
        executable: None,
        ipc_socket: temp.path().join("unused.sock"),
    };
    std::fs::create_dir_all(config.home.join("sessions")).unwrap();
    let reference = MessageRef::of("old-queue");
    let lines = [
        serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"old-turn"}}),
        serde_json::json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"old-turn","item":{"type":"UserMessage","content":[{"type":"text","text":format!("[via Agent Relay — from @owner · ref {reference}]\n\nContinue")} ]}}}),
        serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"old-turn","last_agent_message":"Original peer answer"}}),
    ].iter().map(|value| value.to_string()).collect::<Vec<_>>().join("\n")+"\n";
    std::fs::write(
        config
            .home
            .join("sessions")
            .join(format!("rollout-test-{THREAD}.jsonl")),
        lines,
    )
    .unwrap();
    *fake.rollout.lock().unwrap() = Some(config.clone());
    assert!(rollout::recorded(&config, THREAD, &reference));
    assert!(!recorded(&config, THREAD, "old-queue"));
    let router = CodexRouter::new(fake.clone());
    assert_eq!(
        router.inject_native_existing(THREAD, "old-queue", "Continue"),
        InjectOutcome::Delivered
    );
    assert!(!router.native_choice(THREAD, "old-queue"));
    assert_eq!(
        crate::relay::codex::final_answer(&config, THREAD, &reference).as_deref(),
        Some("Original peer answer")
    );
    assert!(fake.native.lock().unwrap().is_empty());
    assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
}

#[test]
fn prior_peer_queue_or_hidden_handoff_never_becomes_native_after_evidence_disappears() {
    for hidden in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let fake = Fake::new(temp.path());
        fake.queued_message.store(!hidden, Ordering::SeqCst);
        fake.hidden_message.store(hidden, Ordering::SeqCst);
        let first = CodexRouter::new(fake.clone());
        assert!(matches!(
            first.inject_native_existing(THREAD, "prior-peer", "hello"),
            InjectOutcome::Accepted(_)
        ));
        fake.queued_message.store(false, Ordering::SeqCst);
        fake.hidden_message.store(false, Ordering::SeqCst);
        let restarted = CodexRouter::new(fake.clone());
        assert!(matches!(
            restarted.inject_native_existing(THREAD, "prior-peer", "hello"),
            InjectOutcome::Accepted(_)
        ));
        assert!(matches!(
            restarted.inject(THREAD, "prior-peer", "peer framing"),
            InjectOutcome::Accepted(_)
        ));
        fake.peer_recorded.store(true, Ordering::SeqCst);
        assert_eq!(
            restarted.inject_native_existing(THREAD, "prior-peer", "hello"),
            InjectOutcome::Delivered
        );
        assert_eq!(
            restarted.inject(THREAD, "prior-peer", "peer framing"),
            InjectOutcome::Delivered
        );
        assert!(fake.native.lock().unwrap().is_empty());
        assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn saved_native_choice_survives_missing_owner_and_only_retries_original_window() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    fake.idle.store(false, Ordering::SeqCst);
    let router = CodexRouter::new(fake.clone());
    assert!(matches!(
        router.inject_native_existing(THREAD, "busy-choice", "hello"),
        InjectOutcome::WaitingForTurn(_)
    ));
    assert!(router.native_choice(THREAD, "busy-choice"));
    *fake.owner.lock().unwrap() = None;
    assert!(!router.native_continuation(THREAD));
    assert!(router.native_choice(THREAD, "busy-choice"));
    assert!(matches!(
        router.inject_native_existing(THREAD, "busy-choice", "hello"),
        InjectOutcome::Waiting(_)
    ));
    fake.idle.store(true, Ordering::SeqCst);
    *fake.owner.lock().unwrap() = Some("window-generation-1".into());
    assert_eq!(
        router.inject_native_existing(THREAD, "busy-choice", "hello"),
        InjectOutcome::Delivered
    );
    assert_eq!(fake.native.lock().unwrap().len(), 1);
}

#[test]
fn native_peer_receipt_waits_for_recording_after_queue_removal_without_resending() {
    for restart in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let fake = Fake::new(temp.path());
        fake.queued_message.store(true, Ordering::SeqCst);
        let start = Instant::now();
        let elapsed = Arc::new(Mutex::new(Duration::ZERO));
        let make_router = || {
            let mut router = CodexRouter::new(fake.clone());
            let clock = elapsed.clone();
            router.now = Box::new(move || start + *clock.lock().unwrap());
            router
        };
        let first = make_router();
        assert!(matches!(
            first.inject_native_existing(THREAD, "recording-peer", "hello"),
            InjectOutcome::Accepted(_)
        ));
        let path = receipt_path(&fake.path, THREAD, "recording-peer");
        let receipt = std::fs::read(&path).unwrap();
        fake.queued_message.store(false, Ordering::SeqCst);
        let router = if restart { make_router() } else { first };
        assert_eq!(
            router.inject_native_existing(THREAD, "recording-peer", "hello"),
            InjectOutcome::Accepted(RECORDING.into())
        );
        *elapsed.lock().unwrap() = HANDOFF_GRACE - Duration::from_secs(1);
        assert_eq!(
            router.inject(THREAD, "recording-peer", "peer framing"),
            InjectOutcome::Accepted(RECORDING.into())
        );
        *elapsed.lock().unwrap() = HANDOFF_GRACE;
        assert!(matches!(
            router.inject_native_existing(THREAD, "recording-peer", "hello"),
            InjectOutcome::InDoubt(_)
        ));
        fake.peer_recorded.store(true, Ordering::SeqCst);
        assert_eq!(
            router.observe(THREAD, "recording-peer"),
            InjectOutcome::Delivered
        );
        assert_eq!(std::fs::read(path).unwrap(), receipt);
        assert!(fake.native.lock().unwrap().is_empty());
        assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn native_peer_unreadable_queue_preserves_recording_deadline() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Fake::new(temp.path());
    fake.queued_message.store(true, Ordering::SeqCst);
    let first = CodexRouter::new(fake.clone());
    assert!(matches!(
        first.inject_native_existing(THREAD, "unreadable-peer", "hello"),
        InjectOutcome::Accepted(_)
    ));
    let path = receipt_path(&fake.path, THREAD, "unreadable-peer");
    let receipt = std::fs::read(&path).unwrap();
    // The process restarts after acceptance; the queue is initially unreadable.
    let start = Instant::now();
    let elapsed = Arc::new(Mutex::new(Duration::ZERO));
    let mut router = CodexRouter::new(fake.clone());
    let clock = elapsed.clone();
    router.now = Box::new(move || start + *clock.lock().unwrap());
    *fake.queued.lock().unwrap() = None;
    assert_eq!(
        router.inject_native_existing(THREAD, "unreadable-peer", "hello"),
        InjectOutcome::Accepted(QUEUE_UNREADABLE.into())
    );
    *elapsed.lock().unwrap() = HANDOFF_GRACE;
    assert_eq!(
        router.observe(THREAD, "unreadable-peer"),
        InjectOutcome::Accepted(QUEUE_UNREADABLE.into())
    );
    *fake.queued.lock().unwrap() = Some(false);
    fake.queued_message.store(false, Ordering::SeqCst);
    assert!(matches!(
        router.inject(THREAD, "unreadable-peer", "peer framing"),
        InjectOutcome::InDoubt(_)
    ));
    assert_eq!(std::fs::read(path).unwrap(), receipt);
    assert!(fake.native.lock().unwrap().is_empty());
    assert_eq!(fake.peer.load(Ordering::SeqCst), 0);
}
