// Included in the provider fixture module to exercise the actual injector and journal.
fn native_capability(http: &FakeHttp) {
    http.push(200, session());
    http.push(200, br#"{"healthy":true,"version":"1.18.35"}"#.to_vec());
}

fn native_user(request: &Request<'_>) -> Value {
    json!({"info":{"id":OpenCodeInjector::message_id(request),"sessionID":"ses_exact","role":"user"},
        "parts":[{"type":"text","text":request.text}]})
}

fn native_answer(request: &Request<'_>) -> Value {
    json!({"info":{"id":"msg_answer","sessionID":"ses_exact","role":"assistant",
        "parentID":OpenCodeInjector::message_id(request),"finish":"stop","time":{"completed":3}},
        "parts":[{"type":"text","text":"Native answer"},
            {"type":"step-finish","sessionID":"ses_exact","messageID":"msg_answer","reason":"stop"}]})
}

fn accept_native(http: &FakeHttp, request: &Request<'_>) {
    native_capability(http);
    http.push(200, session());
    http.push(200, b"{}".to_vec());
    http.push(204, Vec::new());
    http.push(200, serde_json::to_vec(&native_user(request)).unwrap());
}

#[test]
fn native_turn_has_no_peer_marker_preserves_prompt_policy_and_replies_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let http = Arc::new(FakeHttp::default());
    let binding = binding();
    let cancelled = AtomicBool::new(false);
    let request = request(&binding, &cancelled);
    let reference = crate::relay::delivery::policy::MessageRef::of(request.message_id);
    let receipt = Outcome::Completed {
        receipt_id: format!("opencode:{}", OpenCodeInjector::message_id(&request)),
    };
    accept_native(&http, &request);
    let path = temp.path().join("journal");
    assert_eq!(
        injector(&path, table(), http.clone()).inject_native(&request),
        receipt
    );
    let restarted = injector(&path, table(), http.clone());
    assert_eq!(restarted.inject_native(&request), receipt);
    let transcript =
        serde_json::to_vec(&json!([native_user(&request), native_answer(&request)])).unwrap();
    http.push(200, session());
    http.push(200, transcript.clone());
    assert_eq!(
        crate::relay::delivery::policy::MessageRef::in_text(request.text),
        None
    );
    assert_eq!(
        restarted.final_answer(&binding, &reference).as_deref(),
        Some("Native answer")
    );
    http.push(200, session());
    http.push(200, transcript);
    assert_eq!(
        restarted
            .native_final_answer(&binding, &reference)
            .as_deref(),
        Some("Native answer")
    );
    let peer_retry = Request {
        text: "new peer wrapper",
        ..request
    };
    assert_eq!(restarted.inject(&peer_retry), receipt);
    let calls = http.calls.lock().unwrap();
    let posts: Vec<_> = calls.iter().filter(|call| call.0 == "POST").collect();
    assert_eq!(posts.len(), 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&posts[0].3).unwrap(),
        json!({
            "messageID":OpenCodeInjector::message_id(&request), "parts":[{"type":"text","text":request.text}]
        }),
        "no agent, model, permissions, tools, or peer attribution added"
    );
    assert!(calls
        .iter()
        .all(|call| call.0 == "GET" || call.1.ends_with("/session/ses_exact/prompt_async")));
}

#[test]
fn completed_native_receipt_survives_restart_without_live_readiness_or_resubmission() {
    for unavailable in 0..3 {
        let temp = tempfile::tempdir().unwrap();
        let binding = binding();
        let cancelled = AtomicBool::new(false);
        let request = request(&binding, &cancelled);
        let path = temp.path().join("journal");
        let original_http = Arc::new(FakeHttp::default());
        accept_native(&original_http, &request);
        let original = injector(&path, table(), original_http.clone());
        let completed = original.inject_native(&request);
        assert!(matches!(completed, Outcome::Completed { .. }));
        let receipt = fs::read(original.journal.path(request.delivery_id)).unwrap();
        drop(original);

        let offline = Arc::new(FakeHttp::default());
        offline.push(200, session());
        offline.push(503, b"{}".to_vec());
        if unavailable == 1 {
            offline.responses.lock().unwrap().clear();
            offline.push(200, session());
            offline.push(200, br#"{"healthy":true,"version":"1.18.34"}"#.to_vec());
        }
        let processes = if unavailable == 2 {
            Arc::new(FakeProcesses::default())
        } else {
            table()
        };
        let restarted = injector(&path, processes, offline.clone());
        assert_eq!(restarted.inject_native_guarded(&request, &|| false), completed);
        assert_eq!(fs::read(restarted.journal.path(request.delivery_id)).unwrap(), receipt);
        for changed in [Request { text: "different text", ..request }, Request {
            message_id: "other-message", ..request
        }] {
            assert_eq!(restarted.inject_native(&changed), Outcome::InDoubt(Failure::JournalUnavailable));
        }
        let mut other_owner = binding.clone();
        other_owner.owner_id = "different-owner".into();
        let foreign = Request { binding: &other_owner, ..request };
        assert_eq!(restarted.inject_native(&foreign), Outcome::InDoubt(Failure::JournalUnavailable));
        assert!(offline.calls.lock().unwrap().is_empty(), "receipt-only retries make no provider calls");
        assert_eq!(original_http.calls.lock().unwrap().iter().filter(|call| call.0 == "POST").count(), 1);
    }
}

#[test]
fn native_choice_survives_busy_capability_failure_and_rejects_peer_downgrade() {
    for busy in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        let binding = binding();
        let cancelled = AtomicBool::new(false);
        let request = request(&binding, &cancelled);
        if busy {
            native_capability(&http);
            http.push(200, session());
            http.push(200, br#"{"ses_exact":{"type":"busy"}}"#.to_vec());
        } else {
            http.push(200, session());
            http.push(200, br#"{"healthy":true,"version":"1.18.34"}"#.to_vec());
        }
        let path = temp.path().join("journal");
        let engine = injector(&path, table(), http.clone());
        assert!(matches!(
            engine.inject_native(&request),
            Outcome::Waiting(_)
        ));
        let calls = http.calls.lock().unwrap().len();
        let restarted = injector(&path, table(), http.clone());
        assert_eq!(
            restarted.inject(&request),
            Outcome::Refused(Failure::SessionMismatch)
        );
        let changed = Request {
            text: "Relay peer wrapper: please inspect this",
            ..request
        };
        assert_eq!(
            restarted.inject(&changed),
            Outcome::Refused(Failure::SessionMismatch)
        );
        assert_eq!(
            http.calls.lock().unwrap().len(),
            calls,
            "downgrade performs no provider I/O"
        );
        assert!(restarted
            .final_answer(
                &binding,
                &crate::relay::delivery::policy::MessageRef::of(request.message_id)
            )
            .is_none());
        accept_native(&http, &request);
        assert!(matches!(
            restarted.inject_native(&request),
            Outcome::Completed { .. }
        ));
        assert_eq!(
            http.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.0 == "POST")
                .count(),
            1
        );
    }
}

#[test]
fn native_uncertain_post_is_reconciled_once_and_changed_payload_never_resends() {
    let temp = tempfile::tempdir().unwrap();
    let http = Arc::new(FakeHttp::default());
    let binding = binding();
    let cancelled = AtomicBool::new(false);
    let request = request(&binding, &cancelled);
    native_capability(&http);
    http.push(200, session());
    http.push(200, b"{}".to_vec());
    http.responses.lock().unwrap().push_back(None);
    let path = temp.path().join("journal");
    assert_eq!(
        injector(&path, table(), http.clone()).inject_native(&request),
        Outcome::InDoubt(Failure::TimedOut)
    );
    let restarted = injector(&path, table(), http.clone());
    let changed = Request {
        text: "different text",
        ..request
    };
    assert_eq!(
        restarted.inject_native(&changed),
        Outcome::InDoubt(Failure::JournalUnavailable)
    );
    assert_eq!(
        restarted.inject(&changed),
        Outcome::InDoubt(Failure::PriorAttemptUncertain)
    );
    native_capability(&http);
    http.push(200, session());
    http.push(200, serde_json::to_vec(&native_user(&request)).unwrap());
    assert!(matches!(
        restarted.inject_native(&request),
        Outcome::Completed { .. }
    ));
    assert_eq!(
        http.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.0 == "POST")
            .count(),
        1
    );
}

#[test]
fn native_reply_requires_exact_owner_process_session_and_terminal_parent() {
    let temp = tempfile::tempdir().unwrap();
    let http = Arc::new(FakeHttp::default());
    let binding = binding();
    let cancelled = AtomicBool::new(false);
    let request = request(&binding, &cancelled);
    let reference = crate::relay::delivery::policy::MessageRef::of(request.message_id);
    accept_native(&http, &request);
    let engine = injector(&temp.path().join("journal"), table(), http.clone());
    assert!(matches!(
        engine.inject_native(&request),
        Outcome::Completed { .. }
    ));
    for variant in 0..4 {
        let mut other = binding.clone();
        match variant {
            0 => other.owner_id = "other".into(),
            1 => other.relay_workspace_id = "other".into(),
            2 => other.server_start += 1,
            _ => other.session_id = "ses_other".into(),
        };
        let before = http.calls.lock().unwrap().len();
        assert!(engine.native_final_answer(&other, &reference).is_none());
        assert_eq!(http.calls.lock().unwrap().len(), before);
    }
    for variant in 0..5 {
        let mut answer = native_answer(&request);
        match variant {
            0 => answer["info"]["parentID"] = "msg_other".into(),
            1 => answer["info"]["sessionID"] = "ses_other".into(),
            2 => answer["info"]["time"] = json!({}),
            3 => answer["info"]["error"] = json!({"message":"denied"}),
            _ => answer["parts"]
                .as_array_mut()
                .unwrap()
                .push(json!({"type":"tool","state":{"status":"running"}})),
        };
        http.push(200, session());
        http.push(
            200,
            serde_json::to_vec(&json!([native_user(&request), answer])).unwrap(),
        );
        assert!(engine.native_final_answer(&binding, &reference).is_none());
    }
}

#[test]
fn native_serve_capability_rejects_unknown_and_incompatible_versions() {
    for version in ["1.18.34", "2.0.0", "1.18.35-dev", "garbage", "1.18.35"] {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        http.push(200, session());
        http.push(
            200,
            serde_json::to_vec(&json!({"healthy":true,"version":version})).unwrap(),
        );
        let engine = injector(&temp.path().join("journal"), table(), http.clone());
        assert_eq!(engine.native_continuation(&binding()), version == "1.18.35");
        assert!(http.calls.lock().unwrap().iter().all(|c| c.0 == "GET"));
    }
}

#[test]
fn native_admission_revoked_during_status_read_never_posts_or_falls_back_to_peer() {
    struct HeldStatus {
        inner: Arc<FakeHttp>,
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl HttpTransport for HeldStatus {
        fn request(
            &self,
            method: &str,
            url: &str,
            auth: &str,
            directory: &Path,
            body: Option<&[u8]>,
            timeout: Duration,
        ) -> Option<HttpResponse> {
            if url.ends_with("/session/status") {
                self.entered.send(()).ok()?;
                self.release
                    .lock()
                    .ok()?
                    .recv_timeout(Duration::from_secs(5))
                    .ok()?;
            }
            self.inner
                .request(method, url, auth, directory, body, timeout)
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let http = Arc::new(FakeHttp::default());
    native_capability(&http);
    http.push(200, session());
    http.push(200, b"{}".to_vec());
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let engine = OpenCodeInjector::new(
        table(),
        Arc::new(HeldStatus {
            inner: http.clone(),
            entered,
            release: Mutex::new(held),
        }),
        Arc::new(FakeClock::new()),
        &temp.path().join("journal"),
    )
    .unwrap();
    let allowed = AtomicBool::new(true);
    let cancelled = AtomicBool::new(false);
    let binding = binding();
    let request = request(&binding, &cancelled);
    std::thread::scope(|scope| {
        let attempt = scope
            .spawn(|| engine.inject_native_guarded(&request, &|| allowed.load(Ordering::SeqCst)));
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        allowed.store(false, Ordering::SeqCst);
        release.send(()).unwrap();
        assert_eq!(
            attempt.join().unwrap(),
            Outcome::Refused(Failure::CancelledBeforeSend)
        );
    });
    assert_eq!(
        engine.inject(&Request {
            text: "peer wrapper",
            ..request
        }),
        Outcome::Refused(Failure::SessionMismatch)
    );
    assert!(http
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|call| call.0 != "POST"));
}

#[test]
fn native_cancellation_during_admission_callback_prevents_post() {
    let temp = tempfile::tempdir().unwrap();
    let http = Arc::new(FakeHttp::default());
    native_capability(&http);
    http.push(200, session());
    http.push(200, b"{}".to_vec());
    let engine = injector(&temp.path().join("journal"), table(), http.clone());
    let cancelled = AtomicBool::new(false);
    let binding = binding();
    let request = request(&binding, &cancelled);
    let admit = || {
        cancelled.store(true, Ordering::SeqCst);
        true
    };
    assert_eq!(
        engine.inject_native_guarded(&request, &admit),
        Outcome::Refused(Failure::CancelledBeforeSend)
    );
    assert!(http
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|call| call.0 != "POST"));
    assert_eq!(
        engine.inject(&Request {
            text: "peer wrapper",
            ..request
        }),
        Outcome::Refused(Failure::SessionMismatch)
    );
}

#[test]
fn native_opt_in_preserves_existing_peer_receipt_and_reply_after_restart() {
    for state in ["completed", "accepted", "pending"] {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        let binding = binding();
        let cancelled = AtomicBool::new(false);
        let native = request(&binding, &cancelled);
        let reference = crate::relay::delivery::policy::MessageRef::of(native.message_id);
        let text = format!(
            "[via Agent Relay — from @owner to @opencode · message {} · ref {reference}]\n\n{}",
            native.message_id, native.text
        );
        let peer = Request {
            text: &text,
            ..native
        };
        let path = temp.path().join("journal");
        let first = injector(&path, table(), http.clone());
        http.push(200, session());
        http.push(200, b"{}".to_vec());
        http.push(204, Vec::new());
        http.push(200, serde_json::to_vec(&native_user(&peer)).unwrap());
        let expected = first.inject(&peer);
        assert!(matches!(expected, Outcome::Completed { .. }));
        if state != "completed" {
            // The provider accepted the input, but its acknowledgement or
            // the core's completion write was lost before restart.
            first.journal.replace(&peer, state, None).unwrap();
        }
        let restarted = injector(&path, table(), http.clone());
        let transcript =
            serde_json::to_vec(&json!([native_user(&peer), native_answer(&peer)])).unwrap();
        http.push(200, session());
        http.push(200, transcript.clone());
        assert_eq!(
            restarted.inject_native_guarded(&native, &|| false),
            expected,
            "receipt reconciliation cannot create a new turn even after opt-out"
        );
        assert!(!restarted.has_native_reference(&binding, &reference));
        assert!(restarted.journal.previous_native(&native).is_none());
        assert_eq!(restarted.inject(&peer), expected);
        http.push(200, session());
        http.push(200, transcript);
        assert_eq!(
            restarted.final_answer(&binding, &reference).as_deref(),
            Some("Native answer")
        );
        assert_eq!(
            http.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call.0 == "POST")
                .count(),
            1
        );
    }
}

#[test]
fn native_opt_in_never_promotes_an_unproven_peer_receipt() {
    for variant in 0..5 {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        let binding = binding();
        let cancelled = AtomicBool::new(false);
        let native = request(&binding, &cancelled);
        let peer = Request {
            text: "original peer framing",
            ..native
        };
        let path = temp.path().join("journal");
        let engine = injector(&path, table(), http.clone());
        assert_eq!(engine.journal.claim(&peer).unwrap(), Claim::Send);
        let original = fs::read(engine.journal.path(peer.delivery_id)).unwrap();
        let mut user = native_user(&peer);
        match variant {
            0 => user["parts"][0]["text"] = "different text".into(),
            1 => user["info"]["id"] = "msg_other".into(),
            2 => user["info"]["role"] = "assistant".into(),
            3 => user["info"]["sessionID"] = "ses_other".into(),
            _ => user = json!({}),
        }
        http.push(200, session());
        http.push(200, serde_json::to_vec(&json!([user])).unwrap());
        assert_eq!(
            engine.inject_native(&native),
            Outcome::InDoubt(Failure::PriorAttemptUncertain)
        );
        assert_eq!(
            fs::read(engine.journal.path(peer.delivery_id)).unwrap(),
            original
        );
        assert!(engine.journal.previous_native(&native).is_none());
        assert!(!engine.has_native_reference(
            &binding,
            &crate::relay::delivery::policy::MessageRef::of(native.message_id)
        ));
        assert!(http
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|call| call.0 == "GET"));
    }
}

#[test]
fn native_choice_lookup_keeps_unreadable_and_corrupt_records_without_provider_io() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let http = Arc::new(FakeHttp::default());
    let engine = injector(&temp.path().join("journal"), table(), http.clone());
    let binding = binding();
    let cancelled = AtomicBool::new(false);
    let request = request(&binding, &cancelled);
    assert!(!engine.has_native_choice(request.delivery_id));
    assert!(matches!(
        engine.inject_native(&request),
        Outcome::Waiting(_)
    ));
    let calls = http.calls.lock().unwrap().len();
    assert!(engine.has_native_choice(request.delivery_id));
    assert!(!engine.has_native_choice("another-delivery"));
    let path = engine.journal.directory.join(format!(
        "native-{}.choice",
        Journal::digest(&[request.delivery_id])
    ));
    fs::write(&path, b"corrupt").unwrap();
    assert!(engine.has_native_choice(request.delivery_id));
    fs::set_permissions(&path, fs::Permissions::from_mode(0)).unwrap();
    assert!(engine.has_native_choice(request.delivery_id));
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(temp.path().join("missing"), &path).unwrap();
    assert!(engine.has_native_choice(request.delivery_id));
    assert_eq!(http.calls.lock().unwrap().len(), calls);
}

#[test]
fn opt_out_observes_an_unsettled_native_turn_without_posting_or_peer_text() {
    for state in ["pending", "accepted"] {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        let binding = binding();
        let cancelled = AtomicBool::new(false);
        let request = request(&binding, &cancelled);
        native_capability(&http);
        http.push(200, session());
        http.push(200, b"{}".to_vec());
        http.responses.lock().unwrap().push_back(None);
        let path = temp.path().join("journal");
        assert_eq!(
            injector(&path, table(), http.clone()).inject_native(&request),
            Outcome::InDoubt(Failure::TimedOut)
        );
        let receipt = fs::read_dir(&path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|file| file.extension().is_some_and(|ext| ext == "receipt"))
            .unwrap();
        let saved = fs::read_to_string(&receipt).unwrap();
        assert!(saved.starts_with("pending\n"));
        fs::write(&receipt, saved.replacen("pending", state, 1)).unwrap();
        // The core restarted and the owner turned native continuation off.
        let restarted = injector(&path, table(), http.clone());
        let peer_retry = Request {
            text: "[via Agent Relay — from @owner] peer framing",
            ..request
        };
        let other = json!({"info":{"id":OpenCodeInjector::message_id(&request),
            "sessionID":"ses_exact","role":"user"},"parts":[{"type":"text","text":"edited"}]});
        for transcript in [json!([]), json!([other])] {
            http.push(200, session());
            http.push(200, serde_json::to_vec(&transcript).unwrap());
            assert_eq!(
                restarted.inject(&peer_retry),
                Outcome::InDoubt(Failure::PriorAttemptUncertain),
                "{state}: an unproven message stays in doubt"
            );
        }
        http.push(200, session());
        http.push(
            200,
            serde_json::to_vec(&json!([native_user(&request), native_answer(&request)])).unwrap(),
        );
        let completed = Outcome::Completed {
            receipt_id: format!("opencode:{}", OpenCodeInjector::message_id(&request)),
        };
        assert_eq!(restarted.inject(&peer_retry), completed, "{state}");
        assert_eq!(
            restarted.inject(&peer_retry),
            completed,
            "{state}: settled without I/O"
        );
        let calls = http.calls.lock().unwrap();
        assert_eq!(
            calls.iter().filter(|call| call.0 == "POST").count(),
            1,
            "{state}"
        );
    }
}
