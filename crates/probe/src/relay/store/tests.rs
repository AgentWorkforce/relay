use super::*;
use crate::relay::delivery::policy::Delivery;
use serde_json::json;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const THREAD: &str = "01a0c221-6806-7210-af25-97e104b15049";
const PREFIX: &str = "test-desk";

fn target(id: &str) -> Target {
    Target::new(SessionKind::Codex, id)
}

fn registration(name: &str, target: Target) -> Registration {
    Registration {
        name: name.into(),
        agent_id: format!("id-{name}"),
        target,
        title: name.into(),
        base_url: DEFAULT_BASE_URL.into(),
        registered_at: iso8601_from_seconds(0.0),
        workspace_key: Some(Secret::new("rk_live_cloudcloud")),
        machine_prefix: Some(PREFIX.into()),
        added_by_session: None,
        auto_activated: None,
        missing_since: None,
        archived_at: None,
        webhook: None,
        reply_with_final_answer: None,
        integration_channel_id: None,
        integration_channel_name: None,
        integrations: None,
        route_binding: None,
        spawn: None,
        mcp: None,
        alias: None,
        retired_aliases: None,
        cleared: None,
    }
}

fn fresh(name: &str) -> Registration {
    registration(name, target(&random_uuid()))
}

fn token(value: &str) -> Secret {
    Secret::new(value)
}

#[test]
fn forward_owner_binding_survives_store_roundtrip_and_retires_with_agent() {
    let mut store = Store::default();
    let registration = fresh("owned");
    let id = registration.agent_id.clone();
    assert!(store.add(registration, token("agent-token")));
    store.agent_owners.insert(
        id.clone(),
        crate::relay::cloud_session::AgentOwner {
            user_id: "human-1".into(),
            workspace_id: Some("workspace-1".into()),
        },
    );

    let serialized = serde_json::to_string(&store).unwrap();
    let mut restored: Store = serde_json::from_str(&serialized).unwrap();
    assert_eq!(restored.agent_owners.get(&id).unwrap().user_id, "human-1");
    restored.remove("owned");
    assert!(!restored.agent_owners.contains_key(&id));
    assert!(Store::default().agent_owners.is_empty());
}

fn cloud() -> CloudWorkspace {
    CloudWorkspace {
        key: Secret::new("rk_live_cloudcloud"),
        base_url: DEFAULT_BASE_URL.into(),
        workspace_id: Some("rw_cloud".into()),
        account_workspace_id: None,
        name: None,
        relayfile_workspace_id: None,
    }
}

fn delivery(id: &str, reason: &str) -> Delivery {
    Delivery {
        id: id.into(),
        message_id: id.into(),
        status: "delivered".into(),
        reason: Some(reason.into()),
        sender: Some("alice".into()),
        text: Some("question".into()),
        ..Delivery::default()
    }
}

fn decode(json: &str) -> Store {
    Store::decode(json.as_bytes(), PREFIX).unwrap().store
}

#[test]
fn desktop_identity_source_is_generated_once_during_store_migration() {
    let decoded = Store::decode(br#"{"registrations":[],"tokens":{}}"#, PREFIX).unwrap();
    let source = decoded.store.desktop_sync_source_id.unwrap();
    assert!(is_uuid(&source));
    assert!(decoded.migrated);
}

#[test]
fn desktop_identity_clear_generations_keep_their_own_sessions() {
    let old_session = CloudSession {
        access_token: Secret::new("access"),
        access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
        refresh_token: Some(Secret::new("refresh")),
        refresh_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
        site_url: "https://agentrelay.com".into(),
    };
    let mut store = Store {
        desktop_sync_source_id: Some(random_uuid()),
        cloud_session: Some(old_session.clone()),
        cloud: Some(CloudWorkspace {
            key: Secret::new("rk_live_cloudcloud"),
            base_url: DEFAULT_BASE_URL.into(),
            workspace_id: Some("rw_cast".into()),
            account_workspace_id: Some("workspace".into()),
            name: None,
            relayfile_workspace_id: None,
        }),
        ..Store::default()
    };
    assert!(store.queue_desktop_identity_clear(false));
    let new_session = CloudSession {
        access_token: Secret::new("new-access"),
        access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
        refresh_token: Some(Secret::new("new-refresh")),
        refresh_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
        site_url: "https://agentrelay.com".into(),
    };
    store.cloud_session = Some(new_session.clone());
    assert!(store.queue_desktop_identity_clear(true));
    let clears = store.desktop_identity_clears_pending.unwrap();
    assert_eq!(clears.len(), 2);
    assert_ne!(clears[0].request_id, clears[1].request_id);
    assert_eq!(clears[0].session, old_session);
    assert!(!clears[0].revoke_after);
    assert_eq!(clears[1].session, new_session);
    assert!(clears[1].revoke_after);
}

#[test]
fn a_completed_legacy_identity_clear_is_not_resurrected_by_migration() {
    let legacy = DesktopIdentityClear {
        request_id: None,
        workspace_id: "workspace".into(),
        source_id: "source".into(),
        session: CloudSession {
            access_token: Secret::new("access"),
            access_token_expires_at: None,
            refresh_token: None,
            refresh_token_expires_at: None,
            site_url: "https://agentrelay.com".into(),
        },
        revoke_after: true,
    };
    let base = Store {
        desktop_identity_clears_pending: Some(vec![legacy.clone()]),
        ..Store::default()
    };
    let ours = Store {
        desktop_identity_clears_pending: Some(vec![legacy.normalized()]),
        ..base.clone()
    };
    let theirs = Store {
        desktop_identity_clears_pending: None,
        ..base.clone()
    };
    assert!(Store::merged(&base, &ours, &theirs)
        .desktop_identity_clears_pending
        .is_none());
}

// MARK: Targets

// InjectableAgentsTests.testTargetsOnlyAcceptTheirKindsIdShape.
#[test]
fn targets_only_accept_their_kinds_id_shape() {
    assert!(Target::new(SessionKind::Codex, THREAD).is_valid());
    assert!(!Target::new(SessionKind::Codex, "my-thread-name").is_valid());
    assert!(Target::new(
        SessionKind::ClaudeTerminal,
        "c635e116-20de-4d65-bd85-2547b35f0768"
    )
    .is_valid());
    assert!(!Target::new(SessionKind::ClaudeTerminal, "--print").is_valid());
    assert!(Target::new(SessionKind::ClaudeCloud, "session_01AbCdEf23").is_valid());
    assert!(!Target::new(SessionKind::ClaudeCloud, THREAD).is_valid());
    assert!(!Target::new(SessionKind::ClaudeCloud, "session_short").is_valid());
    assert!(Target::new(SessionKind::Grok, THREAD).is_valid());
    assert!(!Target::new(SessionKind::Grok, "grok-terminal-title").is_valid());
    assert!(Target::new(SessionKind::OpenCode, "ses_1234ABCD").is_valid());
    assert!(!Target::new(SessionKind::OpenCode, "ses_../foreign").is_valid());
}

// testUploadKeyMatchesTheUploadersSessionKey.
#[test]
fn upload_keys_match_the_uploaders_session_keys() {
    let claude = "c635e116-20de-4d65-bd85-2547b35f0768";
    assert_eq!(
        Target::new(SessionKind::Codex, THREAD).upload_key(),
        Some(format!("codex:{THREAD}"))
    );
    assert_eq!(
        Target::new(SessionKind::ClaudeTerminal, claude).upload_key(),
        Some(format!("claude:{claude}"))
    );
    assert_eq!(
        Target::new(SessionKind::ClaudeCloud, "session_01AbCdEf23").upload_key(),
        None
    );
    assert_eq!(
        Target::new(SessionKind::Grok, THREAD).upload_key(),
        Some(format!("grok:{THREAD}"))
    );
    assert_eq!(
        Target::new(SessionKind::GrokOpen, THREAD).upload_key(),
        Some(format!("grok:{THREAD}"))
    );
    for kind in [SessionKind::OpenCode, SessionKind::OpenCodeOpen] {
        assert_eq!(
            Target::new(kind, "ses_1234ABCD").upload_key().as_deref(),
            Some("opencode:ses_1234ABCD")
        );
    }
    assert_eq!(
        Target::new(SessionKind::MuseOpen, THREAD).upload_key(),
        Some(format!("muse:{THREAD}"))
    );
    for id in ["real-gallium", "devin-0123456789abcdef0123456789abcdef"] {
        assert_eq!(
            Target::new(SessionKind::Devin, id).upload_key(),
            Some(format!("devin:{id}"))
        );
    }
    for kind in [SessionKind::OpenClaw, SessionKind::Hermes, SessionKind::Pi] {
        assert_eq!(Target::new(kind, "agent").upload_key(), None);
    }
}

// InjectableRepliesTests.testRegistrationKeepsItsMachinePrefix and
// test_registration_keeps_machine_prefix_after_hostname_changes.
#[test]
fn a_registration_keeps_its_machine_prefix() {
    let mut first = registration("agent", target(THREAD));
    first.agent_id = "123".into();
    first.machine_prefix = Some("first-computer-local".into());
    assert_eq!(
        first.direct_address("renamed-computer"),
        "agent@first-computer-local-123"
    );
    assert_eq!(
        first
            .renamed("new", "456")
            .direct_address("renamed-computer"),
        "new@first-computer-local-456"
    );
    let decoded: Registration =
        serde_json::from_value(serde_json::to_value(&first).unwrap()).unwrap();
    assert_eq!(decoded, first);
}

// testRenameKeepsTheSessionAndWebhook.
#[test]
fn a_rename_keeps_the_session_and_webhook() {
    let mut original = registration("old", target(THREAD));
    original.webhook = Some(Webhook {
        id: "wh_1".into(),
        url: "https://cast.agentrelay.com/v1/hooks/wh_1".into(),
        token: token("wh_live_x"),
        channel_name: "hook-old".into(),
        channel_id: "c1".into(),
    });
    let renamed = original.renamed("new", "2");
    assert_eq!(
        (renamed.name.as_str(), renamed.agent_id.as_str()),
        ("new", "2")
    );
    assert_eq!(renamed.target, original.target);
    assert_eq!(renamed.webhook, original.webhook);
    assert_eq!(renamed.workspace_key, original.workspace_key);

    let mut store = Store::default();
    store.add(original.clone(), token("at_old"));
    let mut without_hook = original;
    without_hook.webhook = None;
    store.update(without_hook);
    assert_eq!(store.registrations[0].webhook, None);
    assert_eq!(store.tokens["old"], token("at_old"));
    assert_eq!(Webhook::channel_name("codex-api", None), "hook-codex-api");
    let recreated = Webhook::channel_name(&"a".repeat(60), Some("0123456789abcdef"));
    assert_eq!(recreated.len(), 64);
    assert!(recreated.ends_with("-0123456789abcdef"));
}

// MARK: Store

// testStoreRemembersInjectedDeliveriesWithABound.
#[test]
fn injected_deliveries_are_remembered_with_a_bound() {
    let mut store = Store::default();
    store.record_injected("del_1");
    store.record_injected("del_1");
    assert_eq!(store.injected_delivery_ids, ["del_1"]);
    for index in 0..REMEMBERED_DELIVERIES + 5 {
        store.record_injected(&format!("d{index}"));
    }
    assert_eq!(store.injected_delivery_ids.len(), REMEMBERED_DELIVERIES);
    assert!(!store.was_injected("del_1"));
    assert!(store.was_injected(&format!("d{}", REMEMBERED_DELIVERIES + 4)));
}

// test_an_in_doubt_delivery_is_never_resent_after_later_traffic_evicts_it_from_injected.
#[test]
fn in_doubt_deliveries_are_bounded_apart_from_injected_ones() {
    let mut store = Store::default();
    store.record_in_doubt("del_doubt");
    for index in 0..REMEMBERED_DELIVERIES {
        store.record_injected(&format!("other-{index}"));
    }
    assert!(!store.was_injected("del_doubt"));
    assert!(store.was_in_doubt("del_doubt") && store.was_handled("del_doubt"));
}

/// The macOS app keeps no `inDoubtDeliveryIDs` and saves the file without
/// them; the delivery must still never be injected again.
#[test]
fn an_in_doubt_delivery_stays_handled_after_a_writer_that_drops_in_doubt_ids() {
    let mut base = Store::default();
    base.record_in_doubt("del_doubt");
    let mut theirs = base.clone();
    theirs.in_doubt_delivery_ids.clear();
    theirs.allow_self_registration = Some(false);
    let mut ours = base.clone();
    ours.auto_activate = Some(true);
    let merged = Store::merged(&base, &ours, &theirs);
    assert!(merged.was_handled("del_doubt"));
}

// testStoreReplacesARegistrationForTheSameSessionOrName.
#[test]
fn the_same_session_is_replaced() {
    let mut store = Store::default();
    store.add(registration("one", target(THREAD)), token("at_1"));
    store.add(registration("two", target(THREAD)), token("at_2"));
    assert_eq!(
        store
            .registrations
            .iter()
            .map(|r| &r.name)
            .collect::<Vec<_>>(),
        ["two"]
    );
    assert_eq!(store.registration_for(&target(THREAD)).unwrap().name, "two");
    store.remove("two");
    assert!(store.registrations.is_empty() && store.tokens.is_empty());
}

// testStoreNeverReplacesAnotherSessionsRegistrationWithTheSameName and
// test_a_name_held_in_another_workspace_is_refused_and_its_token_kept.
#[test]
fn another_sessions_name_is_never_displaced() {
    let mut store = Store::default();
    let first = target(THREAD);
    let second = target("01a0c221-6806-7210-af25-97e104b15050");
    let mut old = registration("shared", first.clone());
    old.base_url = "https://old.example".into();
    assert!(store.add(old, token("at_first")));
    assert!(!store.add(registration("shared", second.clone()), token("at_second")));
    assert_eq!(
        store
            .registrations
            .iter()
            .map(|r| &r.target)
            .collect::<Vec<_>>(),
        [&first]
    );
    assert_eq!(store.tokens.get("shared"), Some(&token("at_first")));
    assert_eq!(store.name_holder("shared", &second).unwrap().target, first);
}

// testPendingCleanupsAreRecordedOnce.
#[test]
fn pending_cleanups_are_recorded_once() {
    let mut store = Store::default();
    let cleanup = PendingCleanup {
        kind: CleanupKind::Channel,
        name: "agent-events-1".into(),
        base_url: DEFAULT_BASE_URL.into(),
        workspace_key: token("rk_live_k"),
    };
    store.add_pending_cleanup(cleanup.clone());
    store.add_pending_cleanup(cleanup);
    store.add_pending_cleanup(PendingCleanup {
        kind: CleanupKind::Agent,
        name: "old-name".into(),
        base_url: DEFAULT_BASE_URL.into(),
        workspace_key: token("rk_live_k"),
    });
    assert_eq!(store.pending_cleanups.unwrap().len(), 2);
}

// testSelfRegistrationMarkerAndOptOutRoundTrip,
// testAutoActivateDefaultsOffAndOptInRoundTrips,
// testStoreRoundTripsTheAgentLedDefaultsMarker.
#[test]
fn settings_default_to_self_registration_on_and_auto_activation_off() {
    let store = decode(r#"{"registrations":[],"tokens":{},"injectedDeliveryIDs":[]}"#);
    assert!(store.allows_self_registration());
    assert!(!store.auto_activates());
    let store = decode(
        r#"{"registrations":[],"tokens":{},"injectedDeliveryIDs":[],"allowSelfRegistration":false,"autoActivate":true,"agentLedDefaultsApplied":true}"#,
    );
    assert!(!store.allows_self_registration());
    assert!(store.auto_activates());
    assert_eq!(store.agent_led_defaults_applied, Some(true));
    let restored = Store::decode(&store.encode(), PREFIX).unwrap().store;
    assert_eq!(restored, store);
}

#[test]
fn automatic_lifecycle_fields_round_trip_and_accept_linux_seconds() {
    let mut store = Store::default();
    store.ensure_desktop_sync_source_id();
    let mut agent = registration("automatic", target(THREAD));
    agent.auto_activated = Some(true);
    agent.missing_since = Some("2026-10-01T12:00:00Z".into());
    store.registrations.push(agent);
    store.auto_activation_events = Some(vec!["2026-10-01T12:01:00Z".into()]);
    assert_eq!(Store::decode(&store.encode(), PREFIX).unwrap().store, store);

    let decoded = decode(&format!(
        r#"{{"registrations":[{{"name":"automatic","agentID":"a1","target":{{"kind":"codex","id":"{THREAD}"}},"title":"work","baseURL":"https://cast.agentrelay.com","registeredAt":1790856000,"autoActivated":true,"missingSince":1790856060}}],"tokens":{{}},"autoActivationEvents":[1790856120],"injectedDeliveryIDs":[]}}"#
    ));
    assert_eq!(
        decoded.registrations[0].missing_since.as_deref(),
        Some("2026-10-01T12:01:00Z")
    );
    assert_eq!(
        decoded.auto_activation_events.as_deref(),
        Some(&["2026-10-01T12:02:00Z".to_string()][..])
    );
}

// MARK: Replies

// testReplyDestinationsAndPreference.
#[test]
fn reply_destinations_and_preference() {
    let mut agent = registration("agent", target(THREAD));
    agent.agent_id = "a1".into();
    let reply =
        |d: &Delivery, r: &Registration| Reply::for_delivery(d, r, PREFIX).map(|r| r.destination);
    assert_eq!(
        reply(&delivery("m1", "dm"), &agent),
        Some(Destination::thread("m1"))
    );
    let mut addressed = delivery("m1", "dm");
    addressed.sender_address = Some("alice@laptop".into());
    assert_eq!(reply(&addressed, &agent), Some(Destination::thread("m1")));
    let mut same_named_remote = delivery("m2", "dm");
    same_named_remote.sender = Some("agent".into());
    same_named_remote.sender_address = Some("agent@other-machine".into());
    assert_eq!(
        reply(&same_named_remote, &agent),
        Some(Destination::thread("m2"))
    );
    let mut exact_self = delivery("m3", "dm");
    exact_self.sender = Some("someone".into());
    exact_self.sender_address = Some(agent.direct_address(PREFIX));
    assert_eq!(reply(&exact_self, &agent), None);
    let mut mention = delivery("m1", "mention");
    mention.channel_id = Some("c1".into());
    assert_eq!(reply(&mention, &agent), Some(Destination::thread("m1")));
    let mut threaded = delivery("m1", "thread-reply");
    threaded.channel_id = Some("c1".into());
    threaded.thread_id = Some("root".into());
    assert_eq!(reply(&threaded, &agent), Some(Destination::thread("root")));
    let mut own = delivery("m1", "dm");
    own.sender = Some("agent".into());
    assert_eq!(reply(&own, &agent), None);
    agent.webhook = Some(Webhook {
        id: "hook".into(),
        url: "https://example.com".into(),
        token: token("test"),
        channel_name: "hook-agent".into(),
        channel_id: "c1".into(),
    });
    let mut posted = delivery("m1", "message");
    posted.channel_id = Some("c1".into());
    assert_eq!(reply(&posted, &agent), None);
    assert!(reply(&threaded, &agent).is_some());
    agent.reply_with_final_answer = Some(false);
    assert_eq!(reply(&delivery("m1", "dm"), &agent), None);
    assert_eq!(
        agent.renamed("new", "a2").reply_with_final_answer,
        Some(false)
    );
}

// testNoAutomaticReplyToIntegrationOrWebhookEvents.
#[test]
fn no_automatic_reply_to_integration_or_webhook_events() {
    let mut agent = registration("codex-api", target(THREAD));
    agent.integration_channel_id = Some("ch_events".into());
    let mut integration = delivery("m1", "message");
    integration.channel_id = Some("ch_events".into());
    integration.sender = Some("__relay_webhook__".into());
    assert_eq!(Reply::for_delivery(&integration, &agent, PREFIX), None);
    let mut hook = delivery("m2", "mention");
    hook.channel_id = Some("ch_other".into());
    hook.sender = Some("__relay_webhook__".into());
    assert_eq!(Reply::for_delivery(&hook, &agent, PREFIX), None);
    let mut person = delivery("m3", "dm");
    person.channel_id = Some("dmch_1".into());
    assert!(Reply::for_delivery(&person, &agent, PREFIX).is_some());
}

// testRepliesQueuedBeforeTheUpgradeCannotReachAProvider.
#[test]
fn replies_queued_before_the_upgrade_cannot_reach_a_provider() {
    let store = decode(
        r#"{"registrations":[],"tokens":{},"injectedDeliveryIDs":[],"replies":[
        {"agentID":"a","messageID":"event","destination":{"thread":{"_0":"event"}}},
        {"agentID":"a","messageID":"dm","destination":{"dm":{"_0":"alice"}}},
        {"agentID":"a","messageID":"sent","destination":{"thread":{"_0":"sent"}},"claimed":true}]}"#,
    );
    assert_eq!(
        store
            .replies
            .as_ref()
            .unwrap()
            .iter()
            .map(|r| r.message_id.as_str())
            .collect::<Vec<_>>(),
        ["dm", "sent"],
    );

    let mut agent = registration("codex-api", target(THREAD));
    agent.integration_channel_id = Some("ch_events".into());
    let mut mention = delivery("m", "mention");
    mention.channel_id = Some("ch_general".into());
    let reply = Reply::for_delivery(&mention, &agent, PREFIX).unwrap();
    assert_eq!(reply.channel_id.as_deref(), Some("ch_general"));
    assert!(!reply.targets_integration(&agent));
    let mut misrouted = reply;
    misrouted.channel_id = Some("ch_events".into());
    assert!(misrouted.targets_integration(&agent));
}

// testNewDMThreadReplySurvivesRelaunchCleanupWithoutChannelID.
#[test]
fn a_new_dm_thread_reply_survives_relaunch_cleanup_without_a_channel() {
    let agent = registration("codex-api", target(THREAD));
    let reply = Reply::for_delivery(&delivery("m", "dm"), &agent, PREFIX).unwrap();
    assert_eq!(reply.routing_version, Some(1));
    let store = Store {
        replies: Some(vec![reply.clone()]),
        ..Store::default()
    };
    let restored = Store::decode(&store.encode(), PREFIX).unwrap().store;
    assert_eq!(restored.replies, Some(vec![reply]));
}

// testLegacyPersistedNameRepliesStillDecode.
#[test]
fn legacy_name_replies_still_decode() {
    let reply: Reply = serde_json::from_str(
        r#"{"agentID":"a","messageID":"m","destination":{"dm":{"_0":"alice"}}}"#,
    )
    .unwrap();
    assert_eq!(
        reply.destination,
        Destination::Dm(Payload {
            value: "alice".into()
        })
    );
}

// testRepliesArePrunedToLiveAgentsAndABoundedHistory.
#[test]
fn replies_are_pruned_to_live_agents_and_a_bounded_history() {
    let mut store = Store::default();
    let live = registration("live", target(THREAD));
    store.add(live.clone(), token("at_live"));
    let reply = |agent: &str, message: &str, sent: bool| Reply {
        agent_id: agent.into(),
        message_id: message.into(),
        destination: Destination::Dm(Payload {
            value: "alice".into(),
        }),
        claimed: sent.then_some(true),
        sender_name: None,
        sender_address: None,
        channel_id: None,
        routing_version: None,
    };
    let mut list = vec![
        reply(&live.agent_id, "pending", false),
        reply("gone", "orphan", false),
    ];
    list.extend((0..REMEMBERED_REPLIES + 3).map(|i| reply(&live.agent_id, &format!("m{i}"), true)));
    store.replies = Some(list);
    store.prune_replies();
    let ids: Vec<&str> = store
        .replies
        .as_ref()
        .unwrap()
        .iter()
        .map(|r| r.message_id.as_str())
        .collect();
    assert!(ids.contains(&"pending"));
    assert!(!ids.contains(&"orphan"));
    assert!(!ids.contains(&"m0"));
    let last = format!("m{}", REMEMBERED_REPLIES + 2);
    assert!(ids.contains(&last.as_str()));
    assert_eq!(ids.len(), REMEMBERED_REPLIES + 1);
}

// testPossibleInjectionKeepsManualAndAutomaticReplyOpportunity.
#[test]
fn a_possible_injection_keeps_manual_and_automatic_reply_opportunities() {
    let mut agent = registration("agent", target(THREAD));
    agent.agent_id = "a1".into();
    agent.reply_with_final_answer = Some(true);
    let mut store = Store {
        registrations: vec![agent.clone()],
        ..Store::default()
    };
    store.record_reply_opportunity(&delivery("m1", "dm"), &agent, true, PREFIX);
    store.record_reply_opportunity(&delivery("m1", "dm"), &agent, true, PREFIX);
    assert_eq!(
        store.reply_routes,
        Some(vec![ReplyRoute {
            agent_id: "a1".into(),
            message_id: "m1".into()
        }])
    );
    let replies = store.replies.unwrap();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].routing_version, Some(1));
    assert_eq!(replies[0].claimed, None);
}

#[test]
fn a_reply_route_recorded_early_can_be_forgotten() {
    let mut agent = registration("agent", target(THREAD));
    agent.agent_id = "a1".into();
    let mut store = Store {
        registrations: vec![agent],
        ..Store::default()
    };
    store.record_reply_route("a1", "m1");
    store.record_reply_route("a1", "m2");
    store.forget_reply_route("a1", "m1");
    let left = store.reply_routes_for("a1");
    assert!(!left.contains("m1"));
    assert!(left.contains("m2"));
    store.forget_reply_route("a1", "m2");
    assert!(store.reply_routes.is_none());
}

#[test]
fn a_socket_reply_during_injection_claims_the_automatic_answer() {
    let mut agent = registration("agent", target("session"));
    agent.agent_id = "a1".into();
    agent.reply_with_final_answer = Some(true);
    let mut store = Store {
        registrations: vec![agent.clone()],
        ..Store::default()
    };
    store.record_reply_route("a1", "m1");
    assert!(store.claim_socket_reply("a1", &Endpoint::Name("alice".into()), Some("m1")));
    store.record_reply_opportunity(&delivery("m1", "dm"), &agent, true, PREFIX);
    let replies = store.replies.unwrap();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].message_id, "m1");
    assert_eq!(replies[0].claimed, Some(true));
}

#[test]
fn an_early_socket_reply_does_not_invent_an_automatic_answer_when_that_is_off() {
    let mut agent = registration("agent", target("session"));
    agent.agent_id = "a1".into();
    let mut store = Store {
        registrations: vec![agent],
        ..Store::default()
    };
    assert!(!store.claim_socket_reply("a1", &Endpoint::Name("alice".into()), Some("m1")));
    assert!(store.replies.is_none());
}

// testSocketHintsDefaultToManualAndExplicitFallbackIsSuppressed.
#[test]
fn socket_replies_default_to_manual_and_claim_the_fallback() {
    let mut agent = registration("agent", target("session"));
    agent.agent_id = "a1".into();
    let mut addressed = delivery("m1", "dm");
    addressed.sender_address = Some("alice@mac".into());
    let mut store = Store {
        registrations: vec![agent.clone()],
        ..Store::default()
    };
    store.record_reply_opportunity(&addressed, &agent, true, PREFIX);
    assert_eq!(store.replies, None);
    assert_eq!(store.reply_routes.as_ref().unwrap().len(), 1);
    let mut fallback = Store::default();
    fallback.record_reply_opportunity(&addressed, &agent, false, PREFIX);
    assert_eq!(fallback.replies.as_ref().unwrap().len(), 1);

    agent.reply_with_final_answer = Some(true);
    store.record_reply_opportunity(&addressed, &agent, true, PREFIX);
    assert!(!store.claim_socket_reply("other", &Endpoint::Name("alice".into()), Some("m1")));
    assert!(!store.claim_socket_reply("a1", &Endpoint::Address("alice@other".into()), None));
    assert!(store.claim_socket_reply("a1", &Endpoint::Address("alice@mac".into()), None));
    let restored = Store::decode(&store.encode(), PREFIX).unwrap().store;
    assert_eq!(restored.replies.unwrap()[0].claimed, Some(true));
    store.replies.as_mut().unwrap()[0].claimed = None;
    assert!(store.claim_socket_reply("a1", &Endpoint::Name("alice".into()), Some("m1")));
}

/// While a rename settles the old name still sends, but the answers it owes
/// already belong to the new agent: a socket send as the old name claims
/// them there.
#[test]
fn the_old_name_claims_answers_the_rename_moved() {
    let session = target("session");
    let mut old = registration("old", session.clone());
    old.agent_id = "a-old".into();
    old.reply_with_final_answer = Some(true);
    let mut store = Store::default();
    store.add(old.clone(), token("at_live_old"));
    store.record_reply_opportunity(&delivery("m1", "dm"), &old, true, PREFIX);
    let renamed = old.renamed("new", "a-new");
    store.remove("old");
    store.add(renamed, token("at_live_new"));
    store.rekey_replies("a-old", "a-new");

    let owner = store.reply_owner(&old).agent_id.clone();
    assert_eq!(owner, "a-new");
    assert!(store.reply_routes_for(&owner).contains("m1"));
    assert!(store.claim_socket_reply(&owner, &Endpoint::Name("alice".into()), Some("m1")));
}

// testRepeatedPlainSendsDoNotClaimOlderTurns.
#[test]
fn repeated_plain_sends_do_not_claim_older_turns() {
    let mut agent = registration("agent", target("session"));
    agent.agent_id = "a1".into();
    agent.reply_with_final_answer = Some(true);
    let mut store = Store::default();
    for id in ["old-turn", "current-turn"] {
        store.record_reply_opportunity(&delivery(id, "dm"), &agent, true, PREFIX);
    }
    let alice = Endpoint::Name("alice".into());
    assert!(store.claim_socket_reply("a1", &alice, None));
    assert!(!store.claim_socket_reply("a1", &alice, None));
    let replies = store.replies.unwrap();
    assert_eq!(replies[0].claimed, None);
    assert_eq!(replies[1].claimed, Some(true));
}

// MARK: Formats and migration

// testAStoreSavedByTheFirstBuildStillLoads.
#[test]
fn a_store_saved_by_the_first_macos_build_still_loads() {
    let decoded = Store::decode(
        br#"{"injectedDeliveryIDs":["del_1"],"registrations":[{"agentID":"1","baseURL":"https://cast.agentrelay.com","name":"claude-x","registeredAt":"2026-09-23T04:53:00Z","target":{"id":"c635e116-20de-4d65-bd85-2547b35f0768","kind":"claude-terminal"},"title":"t"}],"tokens":{"claude-x":"at_live_x"}}"#,
        PREFIX,
    )
    .unwrap();
    let store = decoded.store;
    assert_eq!(store.registrations[0].name, "claude-x");
    assert_eq!(store.registrations[0].workspace_key, None);
    // The prefix it was reachable at until now is recorded, once.
    assert_eq!(
        store.registrations[0].machine_prefix.as_deref(),
        Some(PREFIX)
    );
    assert!(decoded.migrated);
    assert!(store.was_injected("del_1"));
    assert!(!Store::decode(&store.encode(), "other").unwrap().migrated);
}

// testASignInKeyStoredBy2026_09_5MovesToTheAccountSlot.
#[test]
fn a_sign_in_key_stored_by_2026_09_5_moves_to_the_account() {
    let decoded = Store::decode(
        br#"{"registrations":[],"tokens":{},"injectedDeliveryIDs":[],"workspaceKey":"rk_live_signin","workspaceKeySource":"your Agent Relay sign-in","workspaceBaseURL":"https://cast.agentrelay.com"}"#,
        PREFIX,
    )
    .unwrap();
    assert!(decoded.migrated);
    let cloud = decoded.store.cloud.unwrap();
    assert_eq!(cloud.key, token("rk_live_signin"));
    assert_eq!(cloud.base_url, "https://cast.agentrelay.com");
    // A pasted key names no workspace and is dropped.
    let pasted = decode(r#"{"workspaceKey":"rk_live_pasted"}"#);
    assert_eq!(pasted.cloud, None);
    assert!(!String::from_utf8(pasted.encode())
        .unwrap()
        .contains("rk_live_pasted"));
}

// The Linux app kept a session's webhook and integration channel when a new
// agent replaced its registration; those belong to the earlier agent.
#[test]
fn a_linux_webhook_of_an_earlier_agent_is_not_attached() {
    let session = "727cce8d-8074-4ea3-94a0-dea144bf8747";
    let linux = json!({
        "registrations": [
            {"name": "claude-rd-1a2b", "agentID": "agent_new", "target": {"kind": "claude-terminal", "id": session},
             "title": "relay-desktop", "baseURL": "https://cast.agentrelay.com", "registeredAt": 1790683200,
             "workspaceKey": "rk_live_test0000", "machinePrefix": "linux-box"}
        ],
        "tokens": {"claude-rd-1a2b": "at_live_one"},
        "webhooks": {session: {"id": "hook_1", "url": "https://cast.agentrelay.com/v1/hooks/hook_1",
            "secret": "wh_live_s", "channel": "agent-webhook-x", "channel_id": "ch_hook", "agent_id": "agent_old"}},
        "integrations": {session: [{"provider": "github", "resource": "/github/repos/acme/api/**",
            "channel_id": "ch_events", "channel": "agent-events-agent_old"}]}
    });
    let store = Store::decode(linux.to_string().as_bytes(), PREFIX)
        .unwrap()
        .store;
    let claude = &store.registrations[0];
    assert_eq!(claude.webhook, None);
    assert_eq!(claude.integration_channel_id, None);
    assert_eq!(claude.integrations.as_ref().unwrap().len(), 1);
}

// A store the Linux app wrote: Unix-seconds dates, the account at the top
// level, webhooks, integrations and reply parents by session.
#[test]
fn a_linux_store_migrates_without_losing_an_agent() {
    let session = "727cce8d-8074-4ea3-94a0-dea144bf8747";
    let linux = json!({
        "registrations": [
            {"name": "claude-rd-1a2b", "agentID": "agent_1", "target": {"kind": "claude-terminal", "id": session},
             "title": "relay-desktop", "baseURL": "https://cast.agentrelay.com", "registeredAt": 1790683200.5,
             "workspaceKey": "rk_live_test0000", "machinePrefix": "linux-box", "addedBySession": true},
            {"name": "codex-old", "agentID": "agent_2", "target": {"kind": "codex", "id": THREAD},
             "title": "Codex", "baseURL": "https://cast.agentrelay.com", "registeredAt": 0,
             "workspaceKey": null, "addedBySession": false}
        ],
        "tokens": {"claude-rd-1a2b": "at_live_one", "codex-old": "at_live_two"},
        "workspaceKey": "rk_live_signin00",
        "workspaceID": "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        "workspaceName": "Acme",
        "relayfileWorkspaceID": "rw_7ccfea89",
        "injectedDeliveryIDs": ["del_1"],
        "inDoubtDeliveryIDs": ["del_2"],
        "senders": {"cloud:50587328": {"name": "me", "token": "at_person", "base_url": "https://cast.agentrelay.com"}},
        "conversations": {"cloud:50587328": {"name:reviewer": {"conversation_id": "dm_1"}}},
        "replyParents": {session: ["m1", "m2"]},
        "allowSelfRegistration": true,
        "autoActivate": true,
        "agentLedDefaultsApplied": true,
        "webhooks": {session: {"id": "hook_1", "url": "https://cast.agentrelay.com/v1/hooks/hook_1",
            "secret": "wh_live_s", "channel": "agent-webhook-x", "channel_id": "ch_hook", "agent_id": "agent_1"}},
        "integrations": {session: [{"provider": "github", "resource": "/github/repos/acme/api/**",
            "channel_id": "ch_events", "channel": "agent-events-agent_1"}]}
    });
    let decoded = Store::decode(linux.to_string().as_bytes(), PREFIX).unwrap();
    assert!(decoded.migrated);
    let store = decoded.store;
    assert_eq!(store.registrations.len(), 2, "no agent is lost");
    assert_eq!(store.tokens.len(), 2);
    let claude = &store.registrations[0];
    assert_eq!(claude.registered_at, "2026-09-29T12:00:00Z");
    assert_eq!(claude.machine_prefix.as_deref(), Some("linux-box"));
    assert_eq!(claude.added_by_session, Some(true));
    let hook = claude.webhook.as_ref().unwrap();
    assert_eq!(
        (hook.id.as_str(), hook.channel_id.as_str()),
        ("hook_1", "ch_hook")
    );
    assert_eq!(hook.token, token("wh_live_s"));
    assert_eq!(claude.integration_channel_id.as_deref(), Some("ch_events"));
    let integration = &claude.integrations.as_ref().unwrap()[0];
    assert_eq!(
        integration.path_glob.as_deref(),
        Some("/github/repos/acme/api/**")
    );
    assert_eq!(integration.workspace_id, "rw_7ccfea89");
    assert_eq!(integration.ready, Some(true));
    let codex = &store.registrations[1];
    assert_eq!(codex.workspace_key, None);
    assert_eq!(codex.machine_prefix.as_deref(), Some(PREFIX));
    assert_eq!(
        store.reply_routes_for("agent_1"),
        ["m1".to_string(), "m2".to_string()].into()
    );
    // The sign-in's key is the account's workspace.
    let cloud = store.cloud.as_ref().unwrap();
    assert_eq!(cloud.key, token("rk_live_signin00"));
    assert_eq!(
        cloud.account_workspace_id.as_deref(),
        Some("50587328-441d-4acb-b8f3-dbe1b3c5de99")
    );
    assert_eq!(cloud.name.as_deref(), Some("Acme"));
    assert_eq!(cloud.relayfile_workspace_id.as_deref(), Some("rw_7ccfea89"));
    assert!(store.was_injected("del_1") && store.was_in_doubt("del_2"));
    assert!(store.auto_activates());
    // Written back once, in the one format, and read back unchanged.
    let encoded: Value = serde_json::from_slice(&store.encode()).unwrap();
    for gone in [
        "workspaceID",
        "workspaceName",
        "relayfileWorkspaceID",
        "senders",
        "conversations",
        "replyParents",
        "webhooks",
    ] {
        assert!(encoded.get(gone).is_none(), "{gone}");
    }
    let again = Store::decode(&store.encode(), "elsewhere").unwrap();
    assert!(!again.migrated);
    assert_eq!(again.store, store);
}

// The macOS app still decodes what the core writes: required keys are
// always present, optional ones are omitted, dates are ISO-8601 seconds
// and enum payloads keep Swift's `_0` form.
#[test]
fn the_format_stays_readable_by_the_macos_app() {
    let mut store = Store::default();
    store.add(
        registration("agent", target(THREAD)),
        token("at_live_agent"),
    );
    let reply =
        Reply::for_delivery(&delivery("m1", "dm"), &store.registrations[0], PREFIX).unwrap();
    store.replies = Some(vec![reply]);
    let encoded: Value = serde_json::from_slice(&store.encode()).unwrap();
    assert_eq!(
        encoded["registrations"][0]["registeredAt"],
        "1970-01-01T00:00:00Z"
    );
    assert_eq!(encoded["registrations"][0]["agentID"], "id-agent");
    assert_eq!(encoded["registrations"][0]["baseURL"], DEFAULT_BASE_URL);
    assert_eq!(encoded["tokens"]["agent"], "at_live_agent");
    assert_eq!(encoded["injectedDeliveryIDs"], json!([]));
    assert_eq!(
        encoded["replies"][0]["destination"],
        json!({"thread": {"_0": "m1"}})
    );
    assert!(encoded.get("workspaceKey").is_none());
    assert!(encoded["registrations"][0].get("webhook").is_none());
}

#[test]
fn a_future_session_kind_does_not_decode() {
    let undecodable = r#"{"registrations":[{"name":"x","agentID":"1","target":{"kind":"future-kind","id":"x"},"title":"t","baseURL":"https://cast.agentrelay.com","registeredAt":"2026-09-23T04:53:00Z"}],"tokens":{},"injectedDeliveryIDs":[]}"#;
    assert!(Store::decode(undecodable.as_bytes(), PREFIX).is_err());
    assert!(Store::decode(br#"{"registrations": 7}"#, PREFIX).is_err());
    assert!(Store::decode(b"[]", PREFIX).is_err());
}

#[test]
fn the_store_never_prints_a_token() {
    let mut store = Store::default();
    store.add(
        registration("agent", target(THREAD)),
        token("at_live_secret"),
    );
    let printed = format!("{store:?}");
    assert!(!printed.contains("at_live"), "{printed}");
    assert!(!printed.contains("rk_live"), "{printed}");
}

// MARK: Merge

// testMergeTakesEachSidesChanges.
#[test]
fn a_merge_takes_each_sides_changes() {
    let mut base = Store::default();
    base.add(fresh("both"), token("at_live_both"));
    base.record_injected("old");
    let mut ours = base.clone();
    ours.add(fresh("ours"), token("at_live_ours"));
    ours.cloud = Some(cloud());
    ours.record_injected("ours-delivery");
    let mut theirs = base.clone();
    theirs.add(fresh("theirs"), token("at_live_theirs"));
    theirs.remove("both");
    theirs.auto_activate = Some(true);
    theirs.record_injected("theirs-delivery");

    let merged = Store::merged(&base, &ours, &theirs);
    assert_eq!(
        merged
            .registrations
            .iter()
            .map(|r| &r.name)
            .collect::<Vec<_>>(),
        ["theirs", "ours"]
    );
    assert_eq!(
        merged.tokens,
        BTreeMap::from([
            ("theirs".into(), token("at_live_theirs")),
            ("ours".into(), token("at_live_ours"))
        ])
    );
    assert_eq!(merged.cloud, Some(cloud()));
    assert_eq!(merged.auto_activate, Some(true));
    assert_eq!(
        merged.injected_delivery_ids,
        ["old", "theirs-delivery", "ours-delivery"]
    );
}

// testMergePrefersOursWhenBothChangedOneEntry.
#[test]
fn a_merge_prefers_ours_when_both_changed_one_entry() {
    let mut base = Store::default();
    base.add(fresh("agent"), token("at_live_base"));
    let mut ours = base.clone();
    ours.tokens.insert("agent".into(), token("at_live_ours"));
    let mut theirs = base.clone();
    theirs
        .tokens
        .insert("agent".into(), token("at_live_theirs"));
    assert_eq!(
        Store::merged(&base, &ours, &theirs).tokens["agent"],
        token("at_live_ours")
    );
}

// testMergeKeepsOneRegistrationPerSessionAndQueuesTheOtherForCleanup.
#[test]
fn a_merge_keeps_one_registration_per_session_and_queues_the_other() {
    let session = target(THREAD);
    let base = Store::default();
    let mut ours = base.clone();
    ours.add(registration("ours", session.clone()), token("at_live_ours"));
    let mut theirs = base.clone();
    theirs.add(registration("theirs", session), token("at_live_theirs"));
    let merged = Store::merged(&base, &ours, &theirs);
    assert_eq!(
        merged
            .registrations
            .iter()
            .map(|r| &r.name)
            .collect::<Vec<_>>(),
        ["ours"]
    );
    assert_eq!(merged.tokens.keys().collect::<Vec<_>>(), ["ours"]);
    assert_eq!(
        merged
            .pending_cleanups
            .unwrap()
            .iter()
            .map(|c| &c.name)
            .collect::<Vec<_>>(),
        ["theirs"]
    );
}

// testRemovalWinsOverAnEditOfTheSameAgentOnEitherSide.
#[test]
fn a_removal_wins_over_an_edit_on_either_side() {
    let mut base = Store::default();
    base.add(fresh("agent"), token("at_live_agent"));
    let mut edited = base.clone();
    let mut changed = edited.registrations[0].clone();
    changed.reply_with_final_answer = Some(false);
    edited.update(changed);
    let mut removed = base.clone();
    removed.remove("agent");
    for merged in [
        Store::merged(&base, &edited, &removed),
        Store::merged(&base, &removed, &edited),
    ] {
        assert!(merged.registrations.is_empty() && merged.tokens.is_empty());
    }
}

#[test]
fn a_name_added_here_survives_any_concurrent_writer() {
    let session = target(THREAD);
    let mut base = Store::default();
    base.add(registration("old", session.clone()), token("at_live_old"));
    base.add(fresh("other"), token("at_live_other"));
    // A rename here: the session's old name gives way to a new one.
    let mut ours = base.clone();
    ours.remove("old");
    ours.add(registration("new", session.clone()), token("at_live_new"));
    // Meanwhile another process removed every agent, then put the same
    // session on the relay under its own name.
    let mut theirs = Store::default();
    theirs.add(registration("theirs", session), token("at_live_theirs"));
    let merged = Store::merged(&base, &ours, &theirs);
    assert_eq!(
        merged
            .registrations
            .iter()
            .map(|r| &r.name)
            .collect::<Vec<_>>(),
        ["new"]
    );
    assert_eq!(merged.tokens["new"], token("at_live_new"));
}

// testMergeNeverQueuesAKeptAgentForRemoval.
#[test]
fn a_merge_never_queues_a_kept_agent_for_removal() {
    let mut base = Store::default();
    base.add(fresh("agent"), token("at_live_agent"));
    let mut ours = base.clone();
    let mut changed = ours.registrations[0].clone();
    changed.reply_with_final_answer = Some(false);
    ours.update(changed);
    let mut theirs = base.clone();
    for name in ["agent", "old-name"] {
        theirs.add_pending_cleanup(PendingCleanup {
            kind: CleanupKind::Agent,
            name: name.into(),
            base_url: DEFAULT_BASE_URL.into(),
            workspace_key: token("rk_live_other"),
        });
    }
    let merged = Store::merged(&base, &ours, &theirs);
    assert_eq!(
        merged
            .registrations
            .iter()
            .map(|r| &r.name)
            .collect::<Vec<_>>(),
        ["agent"]
    );
    assert_eq!(
        merged
            .pending_cleanups
            .unwrap()
            .iter()
            .map(|c| &c.name)
            .collect::<Vec<_>>(),
        ["old-name"]
    );
}

// testMergeCapsRememberedDeliveries.
#[test]
fn a_merge_caps_remembered_deliveries() {
    let base = Store::default();
    let (mut ours, mut theirs) = (base.clone(), base.clone());
    for index in 0..REMEMBERED_DELIVERIES {
        ours.record_injected(&format!("ours-{index}"));
        theirs.record_injected(&format!("theirs-{index}"));
        ours.record_in_doubt(&format!("ours-{index}"));
        theirs.record_in_doubt(&format!("theirs-{index}"));
    }
    let merged = Store::merged(&base, &ours, &theirs);
    assert_eq!(merged.injected_delivery_ids.len(), REMEMBERED_DELIVERIES);
    assert_eq!(merged.in_doubt_delivery_ids.len(), REMEMBERED_DELIVERIES);
    assert_eq!(
        merged.injected_delivery_ids.last().unwrap(),
        &format!("ours-{}", REMEMBERED_DELIVERIES - 1)
    );
}

// MARK: The file

struct Dir {
    _temp: tempfile::TempDir,
    path: PathBuf,
}

impl Dir {
    fn new() -> Dir {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data/injectable-agents.json");
        Dir { _temp: temp, path }
    }

    fn file(&self) -> StoreFile {
        StoreFile::new(self.path.clone(), PREFIX)
    }

    fn on_disk(&self) -> Store {
        Store::decode(&fs::read(&self.path).unwrap(), PREFIX)
            .unwrap()
            .store
    }

    fn write(&self, store: &Store) {
        fs::create_dir_all(self.path.parent().unwrap()).unwrap();
        fs::write(&self.path, store.encode()).unwrap();
    }

    fn set_aside(&self) -> Vec<PathBuf> {
        fs::read_dir(self.path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("injectable-agents.json.unreadable-")
            })
            .collect()
    }

    #[cfg(unix)]
    fn chmod(&self, mode: u32) {
        fs::set_permissions(&self.path, fs::Permissions::from_mode(mode)).unwrap();
    }
}

/// Root reads a 0000 file, so an unreadable store cannot be staged.
#[cfg(unix)]
fn running_as_root() -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() == 0 }
}

fn with_cloud() -> Store {
    Store {
        cloud: Some(cloud()),
        ..Store::default()
    }
}

// testMissingStoreStartsEmptyWithoutError.
#[test]
fn a_missing_store_starts_empty_without_error() {
    let dir = Dir::new();
    let mut file = dir.file();
    let (store, error) = file.load();
    assert_eq!((store, error), (Store::default(), None));
    let saved = file.save(&with_cloud()).unwrap();
    assert_eq!(saved.cloud, Some(cloud()));
    assert_eq!(dir.on_disk().cloud, Some(cloud()));
    assert!(dir.set_aside().is_empty());
}

// testSavedStoreIsReadableByThisUserOnly.
#[cfg(unix)]
#[test]
fn the_saved_store_is_readable_by_this_user_only() {
    let dir = Dir::new();
    let mut file = dir.file();
    file.load();
    file.save(&with_cloud()).unwrap();
    let mode = fs::metadata(&dir.path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

// testSignInAfterUndecodableStoreKeepsTheOriginalAside.
#[test]
fn an_undecodable_store_is_kept_aside() {
    let dir = Dir::new();
    let mut original = Store::default();
    original.add(fresh("codex-cloud-51de"), token("at_live_token"));
    dir.write(&original);
    let mut json: Value = serde_json::from_slice(&fs::read(&dir.path).unwrap()).unwrap();
    json["registrations"][0]["target"] = json!({"kind": "future-kind", "id": "x"});
    let unreadable = serde_json::to_vec(&json).unwrap();
    fs::write(&dir.path, &unreadable).unwrap();

    let mut file = dir.file();
    let (store, error) = file.load();
    assert!(matches!(error, Some(StoreError::SetAside { .. })));
    assert!(store.registrations.is_empty());
    file.save(&with_cloud()).unwrap();
    let aside = dir.set_aside();
    assert_eq!(aside.len(), 1);
    assert_eq!(fs::read(&aside[0]).unwrap(), unreadable);
    assert_eq!(dir.on_disk().cloud, Some(cloud()));
}

// testUnreadableStoreBlocksSaves.
#[cfg(unix)]
#[test]
fn an_unreadable_store_blocks_saves() {
    if running_as_root() {
        return;
    }
    let dir = Dir::new();
    dir.write(&Store::default());
    dir.chmod(0o000);
    let mut file = dir.file();
    let (_, error) = file.load();
    assert!(matches!(error, Some(StoreError::Unreadable { .. })));
    assert!(file.save(&with_cloud()).is_err());
    dir.chmod(0o600);
    assert_eq!(dir.on_disk().cloud, None);
    assert!(dir.set_aside().is_empty());
}

// testStoreRewrittenUndecodablyByAnotherProcessIsNotOverwritten.
#[test]
fn a_store_another_process_rewrote_undecodably_is_not_overwritten() {
    let dir = Dir::new();
    let mut original = Store::default();
    original.add(fresh("kept"), token("at_live_kept"));
    dir.write(&original);
    let mut file = dir.file();
    file.load();
    let foreign = br#"{"registrations": 7}"#;
    fs::write(&dir.path, foreign).unwrap();
    assert!(matches!(
        file.save(&with_cloud()),
        Err(StoreError::ChangedUnreadable { .. })
    ));
    assert_eq!(fs::read(&dir.path).unwrap(), foreign);
}

// testSignInInOneProcessKeepsARegistrationMadeInAnother.
#[test]
fn a_change_in_one_process_keeps_a_registration_made_in_another() {
    let dir = Dir::new();
    let mut original = Store::default();
    original.add(fresh("kept"), token("at_live_kept"));
    dir.write(&original);

    let mut production = dir.file();
    let mut production_store = production.load().0;
    let mut development = dir.file();
    let mut development_store = development.load().0;

    production_store.add(fresh("codex-cloud-51de"), token("at_live_51de"));
    production_store = production.save(&production_store).unwrap();
    development_store.cloud = Some(cloud());
    let merged = development.save(&development_store).unwrap();

    assert_eq!(
        merged
            .registrations
            .iter()
            .map(|r| &r.name)
            .collect::<Vec<_>>(),
        ["kept", "codex-cloud-51de"]
    );
    assert_eq!(merged.tokens["codex-cloud-51de"], token("at_live_51de"));
    assert_eq!(merged.cloud, Some(cloud()));
    assert_eq!(dir.on_disk(), merged);
    // And the first process, saving again, keeps the sign-in.
    production_store.record_injected("delivery-1");
    assert_eq!(
        production.save(&production_store).unwrap().cloud,
        Some(cloud())
    );
    assert_eq!(dir.on_disk().cloud, Some(cloud()));
}

// testRemovalInOneProcessSurvivesTheOthersSave.
#[test]
fn a_removal_in_one_process_survives_the_others_save() {
    let dir = Dir::new();
    let mut original = Store::default();
    original.add(fresh("gone"), token("at_live_gone"));
    original.add(fresh("kept"), token("at_live_kept"));
    dir.write(&original);
    let (mut first, mut second) = (dir.file(), dir.file());
    let (mut first_store, mut second_store) = (first.load().0, second.load().0);
    first_store.remove("gone");
    first.save(&first_store).unwrap();
    second_store.record_injected("delivery-1");
    second.save(&second_store).unwrap();
    let merged = dir.on_disk();
    assert_eq!(
        merged
            .registrations
            .iter()
            .map(|r| &r.name)
            .collect::<Vec<_>>(),
        ["kept"]
    );
    assert!(!merged.tokens.contains_key("gone"));
    assert_eq!(merged.injected_delivery_ids, ["delivery-1"]);
}

// testConcurrentSavesFromManyProcessesLoseNothing.
#[test]
fn concurrent_saves_from_many_writers_lose_nothing() {
    let dir = Dir::new();
    dir.write(&Store::default());
    let writers: Vec<_> = (0..8)
        .map(|index| {
            let mut file = dir.file();
            let mut store = file.load().0;
            std::thread::spawn(move || {
                store.add(
                    fresh(&format!("agent-{index}")),
                    token(&format!("at_live_{index}")),
                );
                file.save(&store).unwrap();
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let names: HashSet<String> = dir
        .on_disk()
        .registrations
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert_eq!(names, (0..8).map(|i| format!("agent-{i}")).collect());
}

#[test]
fn a_legacy_store_is_migrated_on_disk_once() {
    let dir = Dir::new();
    fs::create_dir_all(dir.path.parent().unwrap()).unwrap();
    fs::write(
        &dir.path,
        br#"{"registrations":[{"name":"claude-x","agentID":"1","target":{"kind":"claude-terminal","id":"c635e116-20de-4d65-bd85-2547b35f0768"},"title":"t","baseURL":"https://cast.agentrelay.com","registeredAt":1790683200,"workspaceKey":null}],"tokens":{"claude-x":"at_live_x"},"workspaceKey":null,"injectedDeliveryIDs":[]}"#,
    )
    .unwrap();
    let (store, error) = dir.file().load();
    assert_eq!(error, None);
    assert_eq!(store.registrations[0].registered_at, "2026-09-29T12:00:00Z");
    let on_disk: Value = serde_json::from_slice(&fs::read(&dir.path).unwrap()).unwrap();
    assert_eq!(
        on_disk["registrations"][0]["registeredAt"],
        "2026-09-29T12:00:00Z"
    );
    assert_eq!(on_disk["registrations"][0]["machinePrefix"], PREFIX);
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(&dir.path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

// testFailedRemovalKeepsRegistrationAndTokenInMemoryAndOnDisk.
#[cfg(unix)]
#[test]
fn a_failed_save_leaves_memory_as_disk_has_it() {
    if running_as_root() {
        return;
    }
    let dir = Dir::new();
    let saved = fresh("self-added");
    let mut original = Store::default();
    original.add(saved.clone(), token("at_live_self"));
    dir.write(&original);
    let handle = StoreHandle::open(dir.path.clone(), PREFIX);
    dir.chmod(0o000);
    assert!(handle.update(|store| store.remove("self-added")).is_err());
    assert_eq!(
        handle.read(|s| s.registration_for(&saved.target).cloned()),
        Some(saved.clone())
    );
    assert_eq!(
        handle.read(|s| s.tokens.get("self-added").cloned()),
        Some(token("at_live_self"))
    );
    assert!(handle.error().is_some());
    dir.chmod(0o600);
    assert_eq!(dir.on_disk().registration_for(&saved.target), Some(&saved));
}

#[cfg(unix)]
#[test]
fn a_remembered_record_stays_in_memory_until_it_can_be_saved() {
    if running_as_root() {
        return;
    }
    let dir = Dir::new();
    dir.write(&Store::default());
    let handle = StoreHandle::open(dir.path.clone(), PREFIX);
    dir.chmod(0o000);
    assert!(handle
        .remember(|store| store.record_injected("del_1"))
        .is_err());
    assert!(
        handle.read(|s| s.was_injected("del_1")),
        "never forgotten, so never injected twice"
    );
    dir.chmod(0o600);
    handle.flush().unwrap();
    assert!(dir.on_disk().was_injected("del_1"));
    assert_eq!(handle.error(), None);
}

#[cfg(unix)]
#[test]
fn a_migration_that_cannot_be_written_back_still_loads() {
    if running_as_root() {
        return;
    }
    let dir = Dir::new();
    fs::create_dir_all(dir.path.parent().unwrap()).unwrap();
    fs::write(
        &dir.path,
        br#"{"registrations":[{"name":"claude-x","agentID":"1","target":{"kind":"claude-terminal","id":"c635e116-20de-4d65-bd85-2547b35f0768"},"title":"t","baseURL":"https://cast.agentrelay.com","registeredAt":1790683200}],"tokens":{"claude-x":"at_live_x"},"injectedDeliveryIDs":[]}"#,
    )
    .unwrap();
    let parent = dir.path.parent().unwrap().to_path_buf();
    // The lock file exists; only writing the migrated store fails.
    fs::write(parent.join("injectable-agents.json.lock"), b"").unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o500)).unwrap();
    let handle = StoreHandle::open(dir.path.clone(), PREFIX);
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        handle.read(|s| s.registrations.len()),
        1,
        "no agent goes offline"
    );
    assert!(handle.read(|s| s.tokens.contains_key("claude-x")));
    assert!(handle.error().is_some());
    handle.update(|s| s.auto_activate = Some(true)).unwrap();
    assert_eq!(handle.error(), None);
    assert_eq!(
        dir.on_disk().registrations[0].registered_at,
        "2026-09-29T12:00:00Z"
    );
}

#[test]
fn a_null_base_url_or_title_still_decodes() {
    let store = decode(
        r#"{"registrations":[{"name":"x","agentID":"1","target":{"kind":"codex","id":"01a0c221-6806-7210-af25-97e104b15049"},"title":null,"baseURL":"https://cast.agentrelay.com","registeredAt":"2026-09-23T04:53:00Z"}],"tokens":{},"injectedDeliveryIDs":[],"cloud":{"key":"rk_live_account00","baseURL":null}}"#,
    );
    assert_eq!(store.registrations[0].title, "");
    assert_eq!(store.cloud.unwrap().base_url, "");
}

#[test]
fn an_archived_registration_is_marked_and_recorded_once() {
    let mut store = Store {
        registrations: vec![registration("codex-api", target(THREAD))],
        ..Store::default()
    };
    assert!(store.mark_archived("codex-api", "other-desk", "2026-10-10T12:00:00Z"));
    assert!(!store.mark_archived("codex-api", PREFIX, "2026-10-10T12:05:00Z"));
    assert!(!store.mark_archived("nobody", PREFIX, "2026-10-10T12:05:00Z"));
    let registration = &store.registrations[0];
    assert_eq!(
        registration.archived_at.as_deref(),
        Some("2026-10-10T12:00:00Z")
    );
    assert_eq!(
        registration.missing_since.as_deref(),
        Some("2026-10-10T12:00:00Z")
    );
    let archived = store.archived_sessions.as_ref().unwrap();
    assert_eq!(archived.len(), 1);
    // The address is the one copied while it was on: its own prefix.
    assert_eq!(
        archived[0].address,
        format!("codex-api@{PREFIX}-id-codex-api")
    );
    assert_eq!(archived[0].target, target(THREAD));
    let round_trip = decode(&String::from_utf8(store.encode()).unwrap());
    assert_eq!(round_trip.archived_sessions, store.archived_sessions);
    assert_eq!(
        round_trip.registrations[0].archived_at,
        registration.archived_at
    );
}

#[test]
fn archived_records_merge_newest_first_and_stay_bounded() {
    let entry = |name: &str, at: &str| ArchivedSession {
        name: name.into(),
        address: format!("{name}@{PREFIX}-id"),
        target: target(&random_uuid()),
        title: name.into(),
        archived_at: at.into(),
    };
    let base = Store::default();
    let ours = Store {
        archived_sessions: Some(vec![entry("ours", "2026-10-10T12:00:00Z")]),
        ..Store::default()
    };
    let theirs = Store {
        archived_sessions: Some(vec![entry("theirs", "2026-10-10T13:00:00Z")]),
        ..Store::default()
    };
    let merged = Store::merged(&base, &ours, &theirs);
    let names: Vec<_> = merged
        .archived_sessions
        .unwrap()
        .into_iter()
        .map(|a| a.name)
        .collect();
    assert_eq!(names, ["theirs", "ours"]);

    let many: Vec<_> = (0..ARCHIVED_SESSIONS_KEPT + 5)
        .map(|i| {
            entry(
                &format!("a{i}"),
                &format!("2026-10-10T12:{:02}:00Z", i % 60),
            )
        })
        .collect();
    let ours = Store {
        archived_sessions: Some(many),
        ..Store::default()
    };
    let theirs = Store {
        archived_sessions: Some(vec![entry("newest", "2026-10-11T00:00:00Z")]),
        ..Store::default()
    };
    let merged = Store::merged(&base, &ours, &theirs)
        .archived_sessions
        .unwrap();
    assert_eq!(merged.len(), ARCHIVED_SESSIONS_KEPT);
    assert_eq!(merged[0].name, "newest");
}

#[test]
fn refused_deliveries_survive_restart_and_concurrent_store_writes() {
    let base = Store::default();
    let mut ours = base.clone();
    let mut theirs = base.clone();
    ours.record_refused("refused-a");
    theirs.record_refused("refused-b");
    let merged = Store::merged(&base, &ours, &theirs);
    let restored: Store = serde_json::from_slice(&serde_json::to_vec(&merged).unwrap()).unwrap();
    for id in ["refused-a", "refused-b"] {
        assert!(restored.was_refused(id));
        assert!(restored.was_handled(id));
        assert!(restored.was_injected(id)); // Legacy no-reinjection marker.
        assert!(restored.was_in_doubt(id)); // Legacy fail-only marker.
    }
    let legacy: Store = serde_json::from_str("{}").unwrap();
    assert!(!legacy.was_refused("refused-a"));
}

#[test]
fn an_older_store_writer_cannot_clear_refusals_by_omitting_the_field() {
    let mut base = Store::default();
    base.record_refused("refused-a");
    let ours = base.clone();
    let mut theirs = base.clone();
    theirs.refused_delivery_ids.clear();
    let merged = Store::merged(&base, &ours, &theirs);
    assert!(merged.was_refused("refused-a"));
    assert!(Store::merged(&base, &theirs, &ours).was_refused("refused-a"));
}

#[test]
fn refusal_merge_preserves_fifo_eviction_at_capacity() {
    let mut base = Store::default();
    for i in 0..REMEMBERED_DELIVERIES {
        base.record_refused(&format!("refused-{i}"));
    }
    let mut changed = base.clone();
    changed.record_refused("new-refusal");
    for merged in [
        Store::merged(&base, &changed, &base),
        Store::merged(&base, &base, &changed),
    ] {
        assert_eq!(merged.refused_delivery_ids, changed.refused_delivery_ids);
    }
    let mut legacy = base.clone();
    legacy.refused_delivery_ids.clear();
    for merged in [
        Store::merged(&base, &changed, &legacy),
        Store::merged(&base, &legacy, &changed),
    ] {
        assert_eq!(merged.refused_delivery_ids, changed.refused_delivery_ids);
    }
}

#[test]
fn pending_refusals_survive_legacy_omission_until_explicitly_settled() {
    let mut base = Store::default();
    base.queue_refusal("pending-refusal", "agent-1");
    for i in 0..REMEMBERED_DELIVERIES {
        base.record_refused(&format!("new-{i}"));
    }
    assert!(
        base.was_refused("pending-refusal"),
        "pending settlement cannot be evicted"
    );
    let restored: Store = serde_json::from_slice(&serde_json::to_vec(&base).unwrap()).unwrap();
    assert!(restored.has_pending_refusal("agent-1"));
    let mut legacy = base.clone();
    legacy.pending_refusal_settlements = None;
    assert!(Store::merged(&base, &base, &legacy).has_pending_refusal("agent-1"));
    assert!(Store::merged(&base, &legacy, &base).has_pending_refusal("agent-1"));
    let mut settled = base.clone();
    settled.settle_refusal("pending-refusal");
    for merged in [
        Store::merged(&base, &settled, &legacy),
        Store::merged(&base, &legacy, &settled),
    ] {
        assert!(!merged.has_pending_refusal("agent-1"));
    }
}

#[test]
fn a_legacy_save_after_shutdown_cannot_make_a_refusal_injectable() {
    let mut store = Store::default();
    store.queue_refusal("refused-before-shutdown", "agent-1");
    let mut legacy = serde_json::to_value(&store).unwrap();
    for field in [
        "refusedDeliveryIDs",
        "pendingRefusalSettlements",
        "inDoubtDeliveryIDs",
    ] {
        legacy.as_object_mut().unwrap().remove(field);
    }
    let restarted: Store = serde_json::from_value(legacy).unwrap();
    assert!(restarted.was_handled("refused-before-shutdown"));
    assert!(
        restarted.was_refused("refused-before-shutdown"),
        "legacy fallback must fail, never acknowledge"
    );
}

#[test]
fn removing_an_agent_retires_its_pending_refusals_even_across_a_concurrent_save() {
    let mut base = Store::default();
    base.add(registration("one", target(THREAD)), token("at_1"));
    base.add(fresh("other"), token("at_other"));
    base.queue_refusal("refused-one", "id-one");
    base.queue_refusal("refused-other", "id-other");
    let mut removed = base.clone();
    removed.remove("one");
    assert!(!removed.has_pending_refusal("id-one"));
    assert!(removed.has_pending_refusal("id-other"));
    assert!(removed.was_handled("refused-one"));
    let mut concurrent = base.clone();
    concurrent.queue_refusal("concurrent-one", "id-one");
    for merged in [
        Store::merged(&base, &removed, &concurrent),
        Store::merged(&base, &concurrent, &removed),
    ] {
        assert!(!merged.has_pending_refusal("id-one"));
        assert!(merged.has_pending_refusal("id-other"));
        assert!(merged.was_handled("concurrent-one"));
    }
    let mut replaced = base.clone();
    replaced.add(registration("new-one", target(THREAD)), token("at_new"));
    assert!(!replaced.has_pending_refusal("id-one"));
    assert!(replaced.has_pending_refusal("id-other"));
}

#[test]
fn legacy_refusal_protection_has_its_own_full_history_window() {
    let mut store = Store::default();
    for i in 0..REMEMBERED_DELIVERIES {
        store.record_refused(&format!("refused-{i}"));
    }
    for i in 0..REMEMBERED_DELIVERIES {
        store.record_injected(&format!("delivered-{i}"));
    }
    let mut legacy = serde_json::to_value(&store).unwrap();
    for field in [
        "refusedDeliveryIDs",
        "pendingRefusalSettlements",
        "inDoubtDeliveryIDs",
    ] {
        legacy.as_object_mut().unwrap().remove(field);
    }
    let restarted: Store = serde_json::from_value(legacy).unwrap();
    for i in 0..REMEMBERED_DELIVERIES {
        assert!(
            restarted.was_refused(&format!("refused-{i}")),
            "refusal {i} lost"
        );
        assert!(
            restarted.was_injected(&format!("refused-{i}")),
            "older injector needs the plain ID"
        );
        assert!(restarted.was_handled(&format!("delivered-{i}")));
    }
    assert!(store.injected_delivery_ids.len() <= REMEMBERED_DELIVERIES * 3);
}

#[test]
fn settled_and_retired_refusals_cannot_reappear_from_legacy_pending_markers() {
    let mut store = Store::default();
    store.queue_refusal("settled", "agent-one");
    store.queue_refusal("retired", "agent-two");
    store.record_injected("ordinary");
    assert_eq!(
        store
            .injected_delivery_ids
            .iter()
            .filter(|id| id.starts_with(PENDING_REFUSAL_MARKER))
            .count(),
        2
    );
    store.settle_refusal("settled");
    store.retire_refusals("agent-two");
    let mut legacy = serde_json::to_value(&store).unwrap();
    for field in [
        "refusedDeliveryIDs",
        "pendingRefusalSettlements",
        "inDoubtDeliveryIDs",
    ] {
        legacy.as_object_mut().unwrap().remove(field);
    }
    let restarted = Store::decode(&serde_json::to_vec(&legacy).unwrap(), PREFIX)
        .unwrap()
        .store;
    assert!(!restarted.has_pending_refusal("agent-one"));
    assert!(!restarted.has_pending_refusal("agent-two"));
    assert!(restarted.was_refused("settled"));
    assert!(restarted.was_refused("retired"));
    assert!(restarted.was_injected("ordinary"));
    assert!(!restarted
        .injected_delivery_ids
        .iter()
        .any(|id| id.starts_with(PENDING_REFUSAL_MARKER)));
}

#[test]
fn refusal_reasons_survive_legacy_saves_and_old_journals_still_decode() {
    let mut store = Store::default();
    store.queue_refusal_with_reason("refused", "agent-one", Some("target session is unknown"));
    let mut legacy = serde_json::to_value(&store).unwrap();
    for field in [
        "refusedDeliveryIDs",
        "pendingRefusalSettlements",
        "inDoubtDeliveryIDs",
    ] {
        legacy.as_object_mut().unwrap().remove(field);
    }
    let restarted = Store::decode(&serde_json::to_vec(&legacy).unwrap(), PREFIX)
        .unwrap()
        .store;
    assert_eq!(
        restarted.pending_refusal_settlements.unwrap()[0]
            .reason
            .as_deref(),
        Some("target session is unknown")
    );
    let old: PendingRefusal =
        serde_json::from_value(serde_json::json!({"deliveryID":"old", "agentID":"agent-one"}))
            .unwrap();
    assert_eq!(old.reason, None);
}

#[test]
fn merge_shortcuts_cannot_restore_retired_refusals_from_legacy_markers() {
    let mut base = Store::default();
    base.add(registration("one", target(THREAD)), token("at_1"));
    base.queue_refusal("refused-one", "id-one");
    // An older store writer removes the credential without understanding
    // the newer refusal journals or local compatibility marker.
    let mut removed = base.clone();
    removed.registrations.clear();
    removed.tokens.clear();
    for merged in [
        Store::merged(&base, &base, &removed),
        Store::merged(&base, &removed, &base),
        Store::merged(&base, &removed, &removed),
    ] {
        assert!(!merged.has_pending_refusal("id-one"));
        let mut legacy = serde_json::to_value(&merged).unwrap();
        for field in [
            "refusedDeliveryIDs",
            "pendingRefusalSettlements",
            "inDoubtDeliveryIDs",
        ] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        let restarted = Store::decode(&serde_json::to_vec(&legacy).unwrap(), PREFIX)
            .unwrap()
            .store;
        assert!(
            !restarted.has_pending_refusal("id-one"),
            "retired work came back"
        );
        assert!(restarted.was_refused("refused-one"));
    }
}

// MARK: Auto-activation failure journal

#[test]
fn activation_blockers_record_and_clear_per_session() {
    let mut store = Store::default();
    let blocked = BTreeMap::from([
        ("devin:one".to_string(), "broker refused".to_string()),
        ("devin:two".to_string(), "writes paused".to_string()),
    ]);
    store.note_activation_outcomes(&[], &blocked, "2026-10-01T12:00:00Z");
    let failures = store.auto_activation_failures.clone().unwrap();
    assert_eq!(failures["devin:one"].message, "broker refused");
    assert_eq!(failures["devin:one"].at, "2026-10-01T12:00:00Z");

    // A repeated blocker keeps its first `at`; a cleared one is dropped.
    let again = BTreeMap::from([("devin:one".to_string(), "broker refused".to_string())]);
    store.note_activation_outcomes(&["devin:two".to_string()], &again, "2026-10-01T12:00:30Z");
    let failures = store.auto_activation_failures.clone().unwrap();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures["devin:one"].at, "2026-10-01T12:00:00Z");

    // A changed blocker is a new event.
    let different = BTreeMap::from([("devin:one".to_string(), "different".to_string())]);
    store.note_activation_outcomes(&[], &different, "2026-10-01T12:01:00Z");
    assert_eq!(
        store.auto_activation_failures.as_ref().unwrap()["devin:one"].at,
        "2026-10-01T12:01:00Z"
    );

    // All clear keeps an explicit empty journal: `None` would read as
    // "never journaled" to a merge and let the blocker come back.
    store.note_activation_outcomes(&["devin:one".to_string()], &BTreeMap::new(), "now");
    assert_eq!(store.auto_activation_failures, Some(BTreeMap::new()));
}

#[test]
fn activation_blockers_for_an_already_registered_session_are_pruned() {
    let mut store = Store::default();
    store.add(registration("agent", target(THREAD)), token("at_live_x"));
    let blocked = BTreeMap::from([(target(THREAD).key(), "should not stick".to_string())]);
    store.note_activation_outcomes(&[], &blocked, "2026-10-01T12:00:00Z");
    assert_eq!(store.auto_activation_failures, Some(BTreeMap::new()));
}

#[test]
fn activation_blockers_stay_bounded() {
    let mut store = Store::default();
    for i in 0..(AUTO_ACTIVATION_FAILURES_KEPT + 5) {
        let blocked = BTreeMap::from([(format!("codex:{i:03}"), "blocked".to_string())]);
        store.note_activation_outcomes(&[], &blocked, &format!("t{i:03}"));
    }
    let failures = store.auto_activation_failures.unwrap();
    assert_eq!(failures.len(), AUTO_ACTIVATION_FAILURES_KEPT);
    assert!(!failures.contains_key("codex:000"));
    assert!(failures.contains_key("codex:024"));
}

#[test]
fn activation_failures_merge_and_decode_without_the_field() {
    let base = Store::default();
    let mut ours = base.clone();
    ours.auto_activation_failures = Some(BTreeMap::from([(
        "devin:one".to_string(),
        ActivationFailure {
            message: "paused".into(),
            at: "t1".into(),
        },
    )]));
    let mut theirs = base.clone();
    theirs.auto_activation_failures = Some(BTreeMap::from([(
        "devin:two".to_string(),
        ActivationFailure {
            message: "refused".into(),
            at: "t2".into(),
        },
    )]));
    let merged = Store::merged(&base, &ours, &theirs);
    let keys: Vec<_> = merged
        .auto_activation_failures
        .as_ref()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(keys, ["devin:one", "devin:two"]);

    // A store written before the field existed still decodes.
    let mut legacy = serde_json::to_value(&merged).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("autoActivationFailures");
    let decoded = Store::decode(&serde_json::to_vec(&legacy).unwrap(), PREFIX)
        .unwrap()
        .store;
    assert_eq!(decoded.auto_activation_failures, None);
}

#[test]
fn merged_activation_failures_drop_registered_targets_and_stay_bounded() {
    // One process journaled the blocker while another registered the
    // session: the merge must not keep evidence the session is blocked.
    let base = Store::default();
    let mut ours = base.clone();
    ours.add(registration("agent", target(THREAD)), token("at_live_x"));
    let mut theirs = base.clone();
    theirs.auto_activation_failures = Some(BTreeMap::from([(
        target(THREAD).key(),
        ActivationFailure {
            message: "refused".into(),
            at: "t1".into(),
        },
    )]));
    let merged = Store::merged(&base, &ours, &theirs);
    assert_eq!(merged.auto_activation_failures, Some(BTreeMap::new()));

    // Two full journals merge into one bounded journal, not 2x the cap.
    let mut ours = Store::default();
    let mut theirs = Store::default();
    for i in 0..AUTO_ACTIVATION_FAILURES_KEPT {
        for (store, key) in [
            (&mut ours, format!("codex:ours-{i:03}")),
            (&mut theirs, format!("codex:theirs-{i:03}")),
        ] {
            store
                .auto_activation_failures
                .get_or_insert_with(BTreeMap::new)
                .insert(
                    key,
                    ActivationFailure {
                        message: "blocked".into(),
                        at: format!("t{i:03}"),
                    },
                );
        }
    }
    let merged = Store::merged(&Store::default(), &ours, &theirs);
    assert_eq!(
        merged.auto_activation_failures.as_ref().unwrap().len(),
        AUTO_ACTIVATION_FAILURES_KEPT
    );
}

// The saved copies a workspace-key rotation must follow: registrations keep
// the key they registered with, and pending cleanups keep the key they still
// owe Relaycast. When discovery verifies a replacement key to the same
// workspace, `Store::rotate_workspace_key` rewrites both so the superseded
// key lapsing cannot strand them.
#[test]
fn rotate_workspace_key_rewrites_saved_copies_for_the_origin() {
    let mut store = Store::default();
    let mut rotated = registration(
        "rotated",
        Target::new(SessionKind::Codex, "00000000-0000-4000-8000-000000000001"),
    );
    rotated.workspace_key = Some(Secret::new("rk_live_old"));
    let mut other_origin = registration(
        "other",
        Target::new(SessionKind::Codex, "00000000-0000-4000-8000-000000000002"),
    );
    other_origin.base_url = "https://other.example".into();
    other_origin.workspace_key = Some(Secret::new("rk_live_old"));
    let mut other_key = registration(
        "otherkey",
        Target::new(SessionKind::Codex, "00000000-0000-4000-8000-000000000003"),
    );
    other_key.workspace_key = Some(Secret::new("rk_live_elsewhere"));
    store.registrations = vec![rotated, other_origin, other_key];
    store.add_pending_cleanup(PendingCleanup {
        kind: CleanupKind::Agent,
        name: "stale".into(),
        base_url: DEFAULT_BASE_URL.into(),
        workspace_key: Secret::new("rk_live_old"),
    });
    store.add_pending_cleanup(PendingCleanup {
        kind: CleanupKind::Channel,
        name: "untouched".into(),
        base_url: DEFAULT_BASE_URL.into(),
        workspace_key: Secret::new("rk_live_elsewhere"),
    });

    let migrated = store.rotate_workspace_key(
        DEFAULT_BASE_URL,
        &Secret::new("rk_live_old"),
        &Secret::new("rk_live_new"),
    );

    assert_eq!(migrated, 2);
    assert_eq!(
        store.registrations[0].workspace_key,
        Some(Secret::new("rk_live_new"))
    );
    // Same key material on another origin is a different workspace's copy.
    assert_eq!(
        store.registrations[1].workspace_key,
        Some(Secret::new("rk_live_old"))
    );
    // A different key at the same origin is not this rotation's business.
    assert_eq!(
        store.registrations[2].workspace_key,
        Some(Secret::new("rk_live_elsewhere"))
    );
    let cleanups = store.pending_cleanups.as_ref().unwrap();
    assert_eq!(cleanups[0].workspace_key, Secret::new("rk_live_new"));
    assert_eq!(cleanups[1].workspace_key, Secret::new("rk_live_elsewhere"));
}

// Recorded rotations are owed work: another process's save must not drop
// one while settling the other, and they round-trip through the on-disk
// encoding.
#[test]
fn pending_key_migrations_survive_merges_and_encoding() {
    let mut ours = Store::default();
    for old_key in ["rk_live_older", "rk_live_old"] {
        ours.record_pending_key_migration(PendingKeyMigration {
            base_url: DEFAULT_BASE_URL.into(),
            old_key: Secret::new(old_key),
            workspace_id: "rw_one".into(),
        });
    }
    let merged = Store::merged(&Store::default(), &ours, &Store::default());
    let pending = merged.pending_key_migrations.clone().unwrap();
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[0].old_key, Secret::new("rk_live_older"));

    let decoded = Store::decode(&serde_json::to_vec(&merged).unwrap(), PREFIX)
        .unwrap()
        .store;
    assert_eq!(decoded.pending_key_migrations, Some(pending.clone()));

    // A writer that cleared one debt wins that entry over the still-pending
    // side without touching the other.
    let mut cleared = merged.clone();
    cleared.clear_pending_key_migrations(&pending[..1]);
    let merged = Store::merged(&merged, &merged, &cleared);
    assert_eq!(
        merged.pending_key_migrations.unwrap(),
        vec![pending[1].clone()]
    );
}

// The single-slot encoding predates the list: a `pendingKeyMigration`
// written by an older build folds into the list on decode.
#[test]
fn a_legacy_pending_key_migration_decodes_into_the_list() {
    let legacy = serde_json::json!({
        "pendingKeyMigration": {
            "baseURL": DEFAULT_BASE_URL,
            "oldKey": "rk_live_old",
            "workspaceID": "rw_one"
        }
    });
    let decoded = Store::decode(&serde_json::to_vec(&legacy).unwrap(), PREFIX)
        .unwrap()
        .store;
    assert_eq!(
        decoded.pending_key_migrations,
        Some(vec![PendingKeyMigration {
            base_url: DEFAULT_BASE_URL.into(),
            old_key: Secret::new("rk_live_old"),
            workspace_id: "rw_one".into(),
        }])
    );
}

fn aliased(name: &str, alias: &str, target: Target) -> Registration {
    Registration {
        alias: Some(AgentAlias {
            name: alias.into(),
            agent_id: format!("id-{alias}"),
            token: token(&format!("at_{alias}")),
            registered_at: iso8601_from_seconds(0.0),
        }),
        ..registration(name, target)
    }
}

#[test]
fn an_alias_is_a_credential_of_its_own_and_holds_its_name() {
    let mut store = Store::default();
    let first = target(THREAD);
    let second = target("01a0c221-6806-7210-af25-97e104b15050");
    assert!(store.add(
        aliased("original", "nickname", first.clone()),
        token("at_original")
    ));
    let (view, alias_token) = store.credential_named("nickname").unwrap();
    assert_eq!(view.name, "nickname");
    assert_eq!(view.agent_id, "id-nickname");
    assert_eq!(view.target, first);
    assert_eq!(alias_token, token("at_nickname"));
    // Answers through the alias are the original agent's.
    assert_eq!(store.reply_owner(&view).name, "original");
    assert_eq!(
        store.credential_for_agent_id("id-nickname").unwrap().0.name,
        "nickname"
    );
    assert_eq!(store.credentials().len(), 2);
    assert_eq!(
        store.registration_answering("nickname").unwrap().name,
        "original"
    );
    // Another session cannot take the alias.
    assert!(!store.add(registration("nickname", second.clone()), token("at_other")));
    assert_eq!(
        store.name_holder("nickname", &second).unwrap().target,
        first
    );
}

#[test]
fn a_writer_without_the_field_does_not_wipe_the_journal() {
    // A store written before the field existed decodes as `None` — the
    // same shape as an explicit clear. Merging must treat that as "did
    // not touch", not as a wipe, or an older process would silently
    // erase every journaled blocker.
    let failure = || ActivationFailure {
        message: "blocked".into(),
        at: "t1".into(),
    };
    let mut base = Store::default();
    base.auto_activation_failures = Some(BTreeMap::from([("devin:held".to_string(), failure())]));
    let ours = base.clone(); // unchanged
    let mut theirs = base.clone();
    theirs.auto_activation_failures = None; // never journaled
    let merged = Store::merged(&base, &ours, &theirs);
    assert_eq!(
        merged.auto_activation_failures.as_ref().unwrap()["devin:held"],
        failure()
    );
}

#[test]
fn an_explicit_clear_survives_the_merge() {
    // The mirror image: a writer that journaled then cleared carries
    // `Some(empty)`, and that clear must reach a peer still holding the
    // blocker — a `None` clear would be mistaken for "never journaled".
    let mut base = Store::default();
    base.auto_activation_failures = Some(BTreeMap::from([(
        "devin:held".to_string(),
        ActivationFailure {
            message: "blocked".into(),
            at: "t1".into(),
        },
    )]));
    let mut ours = base.clone();
    ours.auto_activation_failures = Some(BTreeMap::new()); // cleared
    let theirs = base.clone(); // still holds the blocker
    let merged = Store::merged(&base, &ours, &theirs);
    assert_eq!(merged.auto_activation_failures, Some(BTreeMap::new()));
}

#[test]
fn an_alias_survives_the_store_round_trip_and_a_replacement_queues_its_removal() {
    let mut store = Store::default();
    let first = target(THREAD);
    assert!(store.add(
        aliased("original", "nickname", first.clone()),
        token("at_original")
    ));
    let decoded = Store::decode(&store.encode(), PREFIX).unwrap().store;
    assert_eq!(decoded.registrations[0].alias, store.registrations[0].alias);
    // Registering the session again without the alias releases it.
    assert!(store.add(registration("again", first), token("at_again")));
    let cleanups = store.pending_cleanups.clone().unwrap_or_default();
    assert!(
        cleanups.iter().any(|c| c.name == "nickname"),
        "{cleanups:?}"
    );
}

#[test]
fn concurrent_renames_queue_the_alias_the_merge_dropped() {
    let session = target(THREAD);
    let mut base = Store::default();
    assert!(base.add(
        registration("original", session.clone()),
        token("at_original")
    ));
    let renamed = |alias: &str| {
        let mut store = base.clone();
        let mut r = aliased("original", alias, session.clone());
        r.agent_id = "id-original".into();
        store.update(r);
        store
    };
    let (ours, theirs) = (renamed("first"), renamed("second"));
    let merged = Store::merged(&base, &ours, &theirs);
    let kept = merged.registrations[0].alias_name().unwrap().to_owned();
    let dropped = if kept == "first" { "second" } else { "first" };
    let cleanups = merged.pending_cleanups.clone().unwrap_or_default();
    assert!(cleanups.iter().any(|c| c.name == dropped), "{cleanups:?}");
    assert!(!cleanups.iter().any(|c| c.name == kept), "{cleanups:?}");
}

#[test]
fn a_full_activation_journal_keeps_its_blockers_instead_of_rotating() {
    let mut store = Store::default();
    let blocked: BTreeMap<String, String> = (0..25)
        .map(|i| {
            (
                format!("codex:{i:02}"),
                "At most 20 sessions are live.".to_string(),
            )
        })
        .collect();
    store.note_activation_outcomes(&[], &blocked, "2026-10-17T00:00:00Z");
    let first = store.auto_activation_failures.clone().unwrap();
    assert_eq!(first.len(), AUTO_ACTIVATION_FAILURES_KEPT);
    // The same blockers on the next pass change nothing.
    store.note_activation_outcomes(&[], &blocked, "2026-10-17T00:01:00Z");
    assert_eq!(store.auto_activation_failures.clone().unwrap(), first);
    // One no longer blocked makes room for one that still is.
    let gone = first.keys().next().unwrap().clone();
    let mut fewer = blocked.clone();
    fewer.remove(&gone);
    store.note_activation_outcomes(&[], &fewer, "2026-10-17T00:02:00Z");
    let after = store.auto_activation_failures.clone().unwrap();
    assert_eq!(after.len(), AUTO_ACTIVATION_FAILURES_KEPT);
    assert!(!after.contains_key(&gone));
}

#[test]
fn a_replaced_alias_forwards_and_is_held_until_its_day_is_up() {
    let mut store = Store::default();
    let first = target(THREAD);
    let second = target("01a0c221-6806-7210-af25-97e104b15050");
    let mut renamed = aliased("original", "current", first.clone());
    let retired = RetiredAlias {
        alias: AgentAlias {
            name: "earlier".into(),
            agent_id: "id-earlier".into(),
            token: token("at_earlier"),
            registered_at: iso8601_from_seconds(0.0),
        },
        retired_at: "2026-10-17T00:00:00Z".into(),
    };
    renamed.retired_aliases = Some(vec![retired.clone()]);
    assert!(store.add(renamed, token("at_original")));
    let (view, earlier_token) = store.credential_named("earlier").unwrap();
    assert_eq!(
        (view.agent_id.as_str(), earlier_token),
        ("id-earlier", token("at_earlier"))
    );
    assert_eq!(store.credentials().len(), 3);
    assert_eq!(store.name_holder("earlier", &second).unwrap().target, first);
    let at = |stamp: &str| {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .to_utc()
    };
    assert!(!retired.expired(at("2026-10-17T23:59:59Z")));
    assert!(retired.expired(at("2026-10-18T00:00:00Z")));
    let decoded = Store::decode(&store.encode(), PREFIX).unwrap().store;
    assert_eq!(
        decoded.registrations[0].retired_aliases,
        Some(vec![retired])
    );
}

#[test]
fn complete_archived_classification_survives_recent_list_trimming_and_store_merge() {
    let mut ours = Store::default();
    for n in 0..75 {
        let name = format!("archived-{n}");
        ours.registrations.push(registration(&name, target(&format!("00000000-0000-4000-8000-{n:012}"))));
        assert!(ours.mark_archived(&name, PREFIX, "2026-10-10T12:00:00Z"));
    }
    assert_eq!(ours.archived_sessions.as_ref().unwrap().len(), ARCHIVED_SESSIONS_KEPT);
    assert_eq!(ours.complete_archived_keys().len(), 75);
    assert!(ours.complete_archived_keys().contains("codex:00000000-0000-4000-8000-000000000000"));
    let decoded = decode(&String::from_utf8(ours.encode()).unwrap());
    assert_eq!(decoded.complete_archived_keys(), ours.complete_archived_keys());
    let merged = Store::merged(&Store::default(), &decoded, &Store::default());
    assert_eq!(merged.complete_archived_keys(), ours.complete_archived_keys());
    let shared = ours.complete_archived_keys();
    let mut unrelated = decoded.clone();
    unrelated.registrations[0].title = "Unrelated metadata update".into();
    let merged = Store::merged(&ours, &ours, &unrelated);
    assert!(std::sync::Arc::ptr_eq(&shared, &merged.complete_archived_keys()), "Unchanged archive contents must retain their immutable snapshot across normal saves");
}
