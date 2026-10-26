use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

fn binding(provider: Provider, transport: Transport) -> Binding {
    Binding {
        provider,
        transport,
        workspace_id: "rw_12345678".into(),
        session_id: "devin-12345678".into(),
        endpoint_id: "org-12345678".into(),
        owner_id: "user-1".into(),
        credential_reference: "keychain:devin-1".into(),
        owner_uid: 0,
        auth_id: String::new(),
        protocol_id: String::new(),
        cwd: PathBuf::new(),
        model_id: String::new(),
        agent_version: String::new(),
        executable: PathBuf::new(),
        leader_pid: 0,
        leader_start: 0,
        socket_path: PathBuf::new(),
        socket_device: 0,
        socket_inode: 0,
    }
}

fn grok_binding() -> Binding {
    Binding {
        provider: Provider::Grok,
        transport: Transport::Acp,
        workspace_id: "rw_12345678".into(),
        session_id: "01a0fd4c-3771-7a20-9f41-6f86d56624f9".into(),
        endpoint_id: String::new(),
        owner_id: "user-1".into(),
        credential_reference: format!("probe:grok:{}", "0".repeat(64)),
        owner_uid: unsafe { libc::getuid() },
        auth_id: String::new(),
        protocol_id: String::new(),
        cwd: "/tmp/project with spaces/λ".into(),
        model_id: "grok-4.7".into(),
        agent_version: "1.0.46".into(),
        executable: "/usr/local/bin/grok".into(),
        leader_pid: 1234,
        leader_start: 5678,
        socket_path: "/tmp/grok-leader.sock".into(),
        socket_device: 42,
        socket_inode: 84,
    }
}

#[test]
fn grok_binding_requires_exact_native_identity_and_stays_disabled_by_default() {
    let valid = grok_binding();
    assert_eq!(Gate::default().eligibility(&valid), Eligibility::Disabled);
    let enabled = Gate::enabled([Provider::Grok]);
    assert_eq!(enabled.eligibility(&valid), Eligibility::Eligible);
    let mut stale = valid.clone();
    stale.socket_inode = 0;
    assert_eq!(enabled.eligibility(&stale), Eligibility::AmbiguousIdentity);
    stale = valid.clone();
    stale.socket_path = "/tmp/../foreign.sock".into();
    assert_eq!(enabled.eligibility(&stale), Eligibility::AmbiguousIdentity);
    stale = valid.clone();
    stale.credential_reference = "keychain:irrelevant".into();
    assert_eq!(enabled.eligibility(&stale), Eligibility::AmbiguousIdentity);
    stale = valid;
    stale.transport = Transport::LegacyTui;
    assert_eq!(
        enabled.eligibility(&stale),
        Eligibility::UnsupportedTransport
    );
}

fn request<'a>(binding: &'a Binding, delivery_id: &'a str) -> Request<'a> {
    Request {
        binding,
        delivery_id,
        message_id: "message-1",
        text: "hello",
        timeout: Duration::from_secs(10),
    }
}

struct FakeAdapter {
    provider: Provider,
    calls: AtomicUsize,
    active: AtomicUsize,
    max_active: AtomicUsize,
    outcomes: Mutex<VecDeque<Outcome>>,
}

impl FakeAdapter {
    fn new(outcomes: Vec<Outcome>) -> Self {
        Self::for_provider(Provider::Devin, outcomes)
    }

    fn for_provider(provider: Provider, outcomes: Vec<Outcome>) -> Self {
        Self {
            provider,
            calls: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            outcomes: Mutex::new(outcomes.into()),
        }
    }
}

impl Adapter for FakeAdapter {
    fn provider(&self) -> Provider {
        self.provider
    }

    fn inject(&self, request: &Request<'_>, _command_id: &str) -> Outcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(20));
        self.active.fetch_sub(1, Ordering::SeqCst);
        self.outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Outcome::Delivered {
                receipt_id: request.delivery_id.into(),
            })
    }
}

#[test]
fn grok_recipient_delivery_ids_are_distinct_and_exact_redelivery_is_once() {
    let directory = tempfile::tempdir().unwrap();
    let journal = Journal::new(directory.path().join("journal")).unwrap();
    let stale = journal.directory.join(format!(
        ".{}.tmp",
        Journal::hash(&["recipient-one-delivery", "recipient-one-delivery"])
    ));
    fs::write(stale, b"stale").unwrap();
    let adapter = Arc::new(FakeAdapter::for_provider(Provider::Grok, vec![]));
    let grok = grok_binding();
    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Grok]),
        journal,
        vec![adapter.clone()],
    )
    .unwrap();

    assert_eq!(
        coordinator.inject(&request(&grok, "recipient-one-delivery")),
        Outcome::Delivered {
            receipt_id: "recipient-one-delivery".into(),
        }
    );
    assert_eq!(
        coordinator.inject(&request(&grok, "recipient-two-delivery")),
        Outcome::Delivered {
            receipt_id: "recipient-two-delivery".into(),
        }
    );
    assert_eq!(
        coordinator.inject(&request(&grok, "recipient-one-delivery")),
        Outcome::Delivered {
            receipt_id: "recipient-one-delivery".into(),
        }
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn legacy_and_ambiguous_sessions_fail_closed() {
    let gate = Gate::enabled([Provider::OpenCode, Provider::Devin]);
    assert_eq!(
        gate.eligibility(&binding(Provider::OpenCode, Transport::LegacyTui)),
        Eligibility::UnsupportedTransport
    );
    assert_eq!(
        gate.eligibility(&binding(Provider::Muse, Transport::Courier)),
        Eligibility::AmbiguousIdentity
    );
    assert_eq!(
        gate.eligibility(&binding(Provider::Grok, Transport::Acp)),
        Eligibility::AmbiguousIdentity
    );
    let mut missing = binding(Provider::Devin, Transport::OfficialApi);
    missing.endpoint_id.clear();
    assert_eq!(gate.eligibility(&missing), Eligibility::AmbiguousIdentity);
    missing.endpoint_id = "org-12345678".into();
    missing.credential_reference = "raw-bearer".into();
    assert_eq!(
        gate.eligibility(&missing),
        Eligibility::MissingAuthentication
    );
    assert_eq!(
        Gate::default().eligibility(&binding(Provider::Devin, Transport::OfficialApi)),
        Eligibility::Disabled
    );
}

#[test]
fn durable_command_ids_are_uuidv7() {
    let first = uuid_v7().unwrap();
    let second = uuid_v7().unwrap();
    assert!(is_uuid_v7(&first));
    assert!(is_uuid_v7(&second));
    assert_ne!(first, second);
}

#[test]
fn confirmed_receipt_survives_coordinator_restart_and_owner_rebinding_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let adapter = Arc::new(FakeAdapter::new(vec![Outcome::Delivered {
        receipt_id: "provider-1".into(),
    }]));
    let devin = binding(Provider::Devin, Transport::OfficialApi);
    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Devin]),
        Journal::new(directory.path().join("journal")).unwrap(),
        vec![adapter.clone()],
    )
    .unwrap();
    assert_eq!(
        coordinator.inject(&request(&devin, "delivery-1")),
        Outcome::Delivered {
            receipt_id: "provider-1".into(),
        }
    );
    drop(coordinator);
    let restarted = Coordinator::new(
        Gate::enabled([Provider::Devin]),
        Journal::new(directory.path().join("journal")).unwrap(),
        vec![adapter.clone()],
    )
    .unwrap();
    assert_eq!(
        restarted.inject(&request(&devin, "delivery-1")),
        Outcome::Delivered {
            receipt_id: "provider-1".into(),
        }
    );
    let mut other_owner = devin.clone();
    other_owner.owner_id = "user-2".into();
    assert_eq!(
        restarted.inject(&request(&other_owner, "delivery-1")),
        Outcome::Refused(Failure::RequestConflict)
    );
    let mut other_workspace = devin.clone();
    other_workspace.workspace_id = "rw_other".into();
    assert_eq!(
        restarted.inject(&request(&other_workspace, "delivery-1")),
        Outcome::Refused(Failure::RequestConflict)
    );
    let changed_message = Request {
        binding: &devin,
        delivery_id: "delivery-1",
        message_id: "message-2",
        text: "hello",
        timeout: Duration::from_secs(10),
    };
    assert_eq!(
        restarted.inject(&changed_message),
        Outcome::Refused(Failure::RequestConflict)
    );
    let changed_text = Request {
        message_id: "message-1",
        text: "different prompt",
        ..changed_message
    };
    assert_eq!(
        restarted.inject(&changed_text),
        Outcome::Refused(Failure::RequestConflict)
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn pre_command_grok_receipts_keep_endpoint_and_credential_identity() {
    const PRE_COMMAND_HASH: &str =
        "8f283f97e21616748483c4548231bfe3d5b0bedee6575f4f973923e1dff54788";
    let directory = tempfile::tempdir().unwrap();
    let journal = Journal::new(directory.path().join("journal")).unwrap();
    let adapter = Arc::new(FakeAdapter::for_provider(Provider::Grok, vec![]));
    let mut grok = grok_binding();
    grok.cwd = "/tmp/project".into();
    grok.owner_uid = 12_345;

    for (delivery_id, status, receipt) in [
        (
            "pre-command-delivered",
            "delivered",
            Some("pre-command-provider-receipt"),
        ),
        ("pre-command-pending", "pending", None),
    ] {
        let request = request(&grok, delivery_id);
        assert_eq!(
            Journal::pre_command_grok_request_hash(&request),
            PRE_COMMAND_HASH
        );
        let mut record = journal
            .private_file(&journal.record_path(delivery_id), true)
            .unwrap();
        write!(record, "{status}\n{PRE_COMMAND_HASH}\n").unwrap();
        if let Some(receipt) = receipt {
            writeln!(record, "{receipt}").unwrap();
        }
        record.sync_all().unwrap();
    }

    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Grok]),
        journal,
        vec![adapter.clone()],
    )
    .unwrap();
    assert_eq!(
        coordinator.inject(&request(&grok, "pre-command-delivered")),
        Outcome::Delivered {
            receipt_id: "pre-command-provider-receipt".into(),
        }
    );
    assert_eq!(
        coordinator.inject(&request(&grok, "pre-command-pending")),
        Outcome::InDoubt(Failure::PriorAttemptUncertain)
    );

    let mut changed_credential = grok.clone();
    changed_credential.credential_reference = format!("probe:grok:{}", "1".repeat(64));
    assert_eq!(
        coordinator.inject(&request(&changed_credential, "pre-command-delivered")),
        Outcome::Refused(Failure::RequestConflict)
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn legacy_grok_receipts_remain_readable_without_enabling_replay() {
    const LEGACY_HASH: &str = "e38f229db1c1ad1a2d02058d5f3e078f382eaefebd826586e78889eb9ffb5893";
    let directory = tempfile::tempdir().unwrap();
    let journal = Journal::new(directory.path().join("journal")).unwrap();
    let adapter = Arc::new(FakeAdapter::for_provider(Provider::Grok, vec![]));
    let mut grok = grok_binding();
    // Preserve the exact pre-managed-host fields that produced the historical
    // receipt hash; newer Grok test bindings intentionally exercise a path
    // with spaces and Unicode.
    grok.cwd = "/tmp/project".into();
    grok.owner_uid = 12_345;

    for (delivery_id, status, receipt) in [
        (
            "legacy-delivered",
            "delivered",
            Some("legacy-provider-receipt"),
        ),
        ("legacy-pending", "pending", None),
    ] {
        let request = request(&grok, delivery_id);
        assert_eq!(Journal::legacy_grok_request_hash(&request), LEGACY_HASH);
        let mut record = journal
            .private_file(&journal.record_path(delivery_id), true)
            .unwrap();
        write!(record, "{status}\n{LEGACY_HASH}\n").unwrap();
        if let Some(receipt) = receipt {
            writeln!(record, "{receipt}").unwrap();
        }
        record.sync_all().unwrap();
    }

    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Grok]),
        journal,
        vec![adapter.clone()],
    )
    .unwrap();
    assert_eq!(
        coordinator.inject(&request(&grok, "legacy-delivered")),
        Outcome::Delivered {
            receipt_id: "legacy-provider-receipt".into(),
        }
    );
    assert_eq!(
        coordinator.inject(&request(&grok, "legacy-pending")),
        Outcome::InDoubt(Failure::PriorAttemptUncertain)
    );

    let changed = Request {
        binding: &grok,
        delivery_id: "legacy-delivered",
        message_id: "message-1",
        text: "changed legacy payload",
        timeout: Duration::from_secs(10),
    };
    assert_eq!(
        coordinator.inject(&changed),
        Outcome::Refused(Failure::RequestConflict)
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn uncertain_send_is_never_resent_and_certain_retry_can_send_again() {
    let directory = tempfile::tempdir().unwrap();
    let adapter = Arc::new(FakeAdapter::new(vec![
        Outcome::InDoubt(Failure::TimedOut),
        Outcome::Retry(Failure::EndpointUnavailable),
        Outcome::Delivered {
            receipt_id: "provider-2".into(),
        },
    ]));
    let devin = binding(Provider::Devin, Transport::OfficialApi);
    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Devin]),
        Journal::new(directory.path().join("journal")).unwrap(),
        vec![adapter.clone()],
    )
    .unwrap();
    assert_eq!(
        coordinator.inject(&request(&devin, "uncertain")),
        Outcome::InDoubt(Failure::TimedOut)
    );
    assert_eq!(
        coordinator.inject(&request(&devin, "uncertain")),
        Outcome::InDoubt(Failure::PriorAttemptUncertain)
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        coordinator.inject(&request(&devin, "certain")),
        Outcome::Retry(Failure::EndpointUnavailable)
    );
    assert_eq!(
        coordinator.inject(&request(&devin, "certain")),
        Outcome::Delivered {
            receipt_id: "provider-2".into(),
        }
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 3);
}

#[test]
fn two_deliveries_to_one_session_are_serialized() {
    let directory = tempfile::tempdir().unwrap();
    let adapter = Arc::new(FakeAdapter::new(vec![]));
    let coordinator = Arc::new(
        Coordinator::new(
            Gate::enabled([Provider::Devin]),
            Journal::new(directory.path().join("journal")).unwrap(),
            vec![adapter.clone()],
        )
        .unwrap(),
    );
    let devin = binding(Provider::Devin, Transport::OfficialApi);
    std::thread::scope(|scope| {
        for index in 0..2 {
            let coordinator = coordinator.clone();
            let devin = devin.clone();
            scope.spawn(move || {
                let id = format!("delivery-{index}");
                assert_eq!(
                    coordinator.inject(&request(&devin, &id)),
                    Outcome::Delivered {
                        receipt_id: id.clone(),
                    }
                );
            });
        }
    });
    assert_eq!(adapter.max_active.load(Ordering::SeqCst), 1);
}

#[test]
fn unreadable_or_replaced_receipt_fails_without_contacting_provider() {
    let directory = tempfile::tempdir().unwrap();
    let journal = Journal::new(directory.path().join("journal")).unwrap();
    let outside = directory.path().join("outside");
    fs::write(&outside, b"untouched").unwrap();
    std::os::unix::fs::symlink(&outside, journal.record_path("delivery-1")).unwrap();
    let adapter = Arc::new(FakeAdapter::new(vec![]));
    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Devin]),
        journal,
        vec![adapter.clone()],
    )
    .unwrap();
    let devin = binding(Provider::Devin, Transport::OfficialApi);
    assert_eq!(
        coordinator.inject(&request(&devin, "delivery-1")),
        Outcome::InDoubt(Failure::JournalUnavailable)
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(outside).unwrap(), b"untouched");
}

#[test]
fn journal_failures_before_any_send_are_retried_and_leave_no_receipt() {
    use std::os::unix::fs::PermissionsExt;
    let devin = binding(Provider::Devin, Transport::OfficialApi);
    let delivered = Outcome::Delivered {
        receipt_id: "receipt-1".into(),
    };

    // Pre-send: a route lock that is not private cannot be taken.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("journal");
    let journal = Journal::new(&path).unwrap();
    let lock = path.join(format!("route-{}.lock", Journal::route_hash(&devin)));
    fs::write(&lock, b"").unwrap();
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o644)).unwrap();
    let adapter = Arc::new(FakeAdapter::new(vec![delivered.clone()]));
    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Devin]),
        journal,
        vec![adapter.clone()],
    )
    .unwrap();
    assert_eq!(
        coordinator.inject(&request(&devin, "delivery-1")),
        Outcome::Retry(Failure::JournalUnavailable)
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
    assert!(!coordinator.journal.record_path("delivery-1").exists());
    // The retry is a first attempt, not PriorAttemptUncertain.
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        coordinator.inject(&request(&devin, "delivery-1")),
        delivered
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);

    // Pre-send: a journal directory that refuses new records, with its
    // route lock already present and private.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("journal");
    let journal = Journal::new(&path).unwrap();
    let lock = path.join(format!("route-{}.lock", Journal::route_hash(&devin)));
    fs::write(&lock, b"").unwrap();
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o500)).unwrap();
    let adapter = Arc::new(FakeAdapter::new(vec![delivered.clone()]));
    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Devin]),
        journal,
        vec![adapter.clone()],
    )
    .unwrap();
    let refused = coordinator.inject(&request(&devin, "delivery-1"));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(refused, Outcome::Retry(Failure::JournalUnavailable));
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
    assert!(!coordinator.journal.record_path("delivery-1").exists());
    assert_eq!(
        coordinator.inject(&request(&devin, "delivery-1")),
        delivered
    );
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);

    // Post-send: the adapter runs, then settling its receipt fails. That is
    // still in doubt, and the provider is never asked again.
    struct SpoilsReceipt(std::path::PathBuf, AtomicUsize);
    impl Adapter for SpoilsReceipt {
        fn provider(&self) -> Provider {
            Provider::Devin
        }
        fn inject(&self, _request: &Request<'_>, _command_id: &str) -> Outcome {
            self.1.fetch_add(1, Ordering::SeqCst);
            // The receipt rename will now land on a non-empty directory.
            fs::remove_file(&self.0).unwrap();
            fs::create_dir(&self.0).unwrap();
            fs::write(self.0.join("occupied"), b"").unwrap();
            Outcome::Delivered {
                receipt_id: "receipt-1".into(),
            }
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let journal = Journal::new(directory.path().join("journal")).unwrap();
    let adapter = Arc::new(SpoilsReceipt(
        journal.record_path("delivery-1"),
        AtomicUsize::new(0),
    ));
    let coordinator = Coordinator::new(
        Gate::enabled([Provider::Devin]),
        journal,
        vec![adapter.clone()],
    )
    .unwrap();
    assert_eq!(
        coordinator.inject(&request(&devin, "delivery-1")),
        Outcome::InDoubt(Failure::JournalUnavailable)
    );
    assert_eq!(adapter.1.load(Ordering::SeqCst), 1);
    assert!(matches!(
        coordinator.inject(&request(&devin, "delivery-1")),
        Outcome::InDoubt(_)
    ));
    assert_eq!(adapter.1.load(Ordering::SeqCst), 1);
}

#[test]
fn journal_sweep_removes_only_stale_orphan_temp_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("journal");
    Journal::new(&path).unwrap();
    let orphan = path.join(format!(".{}-{}.tmp", "a".repeat(64), "b".repeat(32)));
    let kept = [
        path.join(format!("{}.receipt", "c".repeat(64))),
        path.join(format!("route-{}.lock", "d".repeat(64))),
        path.join(format!(".{}.tmp", "e".repeat(64))),
        path.join(format!(".{}-{}.tmp", "F".repeat(64), "b".repeat(32))),
        path.join("unrelated.tmp"),
    ];
    for file in std::iter::once(&orphan).chain(&kept) {
        fs::write(file, b"x").unwrap();
    }
    let linked = path.join(format!(".{}-{}.tmp", "1".repeat(64), "2".repeat(32)));
    std::os::unix::fs::symlink(&kept[0], &linked).unwrap();

    // A temp written after the cutoff may belong to a replacement in flight.
    sweep_stale_journal_temps(&path, SystemTime::now() - Duration::from_secs(3600));
    assert!(orphan.exists());

    sweep_stale_journal_temps(&path, SystemTime::now() + Duration::from_secs(1));
    assert!(!orphan.exists());
    assert!(
        fs::symlink_metadata(&linked).is_ok(),
        "symlinks are never swept"
    );
    for file in &kept {
        assert!(file.exists(), "{}", file.display());
    }
}

#[test]
fn eligibility_checks_transport_before_identity_and_authentication_before_enablement() {
    for provider in [
        Provider::Grok,
        Provider::Muse,
        Provider::OpenCode,
        Provider::Devin,
    ] {
        for transport in [
            Transport::LegacyTui,
            Transport::AuthenticatedServer,
            Transport::OfficialApi,
            Transport::Courier,
            Transport::Acp,
        ] {
            let mut invalid = binding(provider, transport);
            invalid.workspace_id.clear();
            let supported = matches!(
                (provider, transport),
                (Provider::Grok, Transport::Acp)
                    | (Provider::Muse, Transport::Courier)
                    | (Provider::OpenCode, Transport::AuthenticatedServer)
                    | (Provider::Devin, Transport::OfficialApi)
            );
            assert_eq!(
                Gate::default().eligibility(&invalid),
                if supported {
                    Eligibility::AmbiguousIdentity
                } else {
                    Eligibility::UnsupportedTransport
                },
                "{provider:?}/{transport:?}"
            );
        }
    }
    for (provider, transport) in [
        (Provider::Devin, Transport::OfficialApi),
        (Provider::OpenCode, Transport::AuthenticatedServer),
    ] {
        let mut valid = binding(provider, transport);
        for credential in ["", "keychain:", "probe:", "raw-bearer", "probe:bad key"] {
            valid.credential_reference = credential.into();
            assert_eq!(
                Gate::default().eligibility(&valid),
                Eligibility::MissingAuthentication
            );
        }
        for credential in ["keychain:valid", "probe:valid"] {
            valid.credential_reference = credential.into();
            assert_eq!(Gate::default().eligibility(&valid), Eligibility::Disabled);
            assert_eq!(
                Gate::enabled([provider]).eligibility(&valid),
                Eligibility::Eligible
            );
        }
    }
}

#[test]
fn every_grok_native_identity_field_remains_required() {
    use serde_json::json;
    for valid in [grok_binding()] {
        for (field, value) in [
            ("workspace_id", json!("")),
            ("session_id", json!("")),
            ("owner_id", json!("")),
            ("model_id", json!("")),
            ("agent_version", json!("")),
            ("owner_uid", json!(0)),
            ("leader_pid", json!(1)),
            ("leader_start", json!(0)),
            ("socket_device", json!(0)),
            ("socket_inode", json!(0)),
            ("cwd", json!("relative")),
            ("cwd", json!("/tmp/../other")),
            ("executable", json!("relative")),
            ("socket_path", json!("relative")),
        ] {
            let mut value_of_binding = serde_json::to_value(&valid).unwrap();
            value_of_binding[field] = value;
            let invalid: Binding = serde_json::from_value(value_of_binding).unwrap();
            assert_eq!(
                Gate::enabled([valid.provider]).eligibility(&invalid),
                Eligibility::AmbiguousIdentity,
                "{:?}/{field}",
                valid.provider
            );
            assert_eq!(
                Gate::default().eligibility(&invalid),
                Eligibility::AmbiguousIdentity
            );
        }
    }
}

#[test]
fn receipt_parsing_keeps_uncertain_and_conflicting_records_distinct() {
    let binding = binding(Provider::Devin, Transport::OfficialApi);
    let request = request(&binding, "delivery");
    let hash = Journal::request_hash(&request);
    let command = uuid_v7().unwrap();
    for contents in [
        String::new(),
        "pending".into(),
        format!("unknown\n{hash}\n{command}\nreceipt\n"),
        format!("pending\n{hash}\n"),
        format!("pending\n{hash}\nnot-a-command\n"),
        format!("delivered\n{hash}\n{command}\n"),
        format!("delivered\n{hash}\n{command}\ninvalid receipt\n"),
        format!("delivered\n{hash}\nnot-a-command\nreceipt\n"),
    ] {
        assert_eq!(
            Journal::parse_receipt(&contents, &request, &hash),
            Claim::InDoubt,
            "{contents:?}"
        );
    }
    assert_eq!(
        Journal::parse_receipt("pending\nanother-hash\n", &request, &hash),
        Claim::RequestConflict
    );
    assert_eq!(
        Journal::parse_receipt(&format!("pending\n{hash}\n{command}\n"), &request, &hash),
        Claim::Replay(command.clone())
    );
    assert_eq!(
        Journal::parse_receipt(
            &format!("delivered\n{hash}\n{command}\nreceipt\n"),
            &request,
            &hash
        ),
        Claim::Delivered("receipt".into())
    );
}
