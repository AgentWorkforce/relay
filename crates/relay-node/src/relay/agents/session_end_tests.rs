//! Which registrations heartbeat and which leave once their session ends:
//! an ended session's channel closes at once, and an automatic or spawned
//! registration leaves after the grace period; a brief miss and an idle
//! session keep theirs; a hand-added one stays registered without a
//! channel until its session runs again.

use super::*;
use crate::relay::store::{Registration, Store, Target};

const THREAD: &str = "01a0c221-6806-7210-af25-97e104b15049";

fn at(text: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(text)
        .unwrap()
        .with_timezone(&chrono::Utc)
}

fn registration(name: &str, n: u8) -> Registration {
    serde_json::from_value(serde_json::json!({
        "name": name,
        "agentID": format!("agent-{name}"),
        "target": {"kind": "codex", "id": format!("{}{n:02}", &THREAD[..34])},
        "baseURL": "https://cast.agentrelay.com",
        "registeredAt": "2026-10-01T12:00:00Z",
    }))
    .unwrap()
}

fn automatic(name: &str, n: u8) -> Registration {
    Registration {
        auto_activated: Some(true),
        ..registration(name, n)
    }
}

fn spawned(name: &str, n: u8) -> Registration {
    Registration {
        spawn: Some(
            serde_json::from_value::<crate::relay::store::SpawnOrigin>(serde_json::json!({
                "nodeID": "node_1", "nodeName": "desk-desktop",
                "invocationID": format!("inv_{name}"), "harness": "codex",
            }))
            .unwrap(),
        ),
        ..registration(name, n)
    }
}

fn hand_added(name: &str, n: u8, by_session: bool) -> Registration {
    Registration {
        added_by_session: Some(by_session),
        ..registration(name, n)
    }
}

fn targets(store: &Store) -> HashSet<Target> {
    store
        .registrations
        .iter()
        .map(|r| r.target.clone())
        .collect()
}

fn heartbeating(store: &Store) -> Vec<String> {
    store
        .registrations
        .iter()
        .filter(|r| heartbeats(r))
        .map(|r| r.name.clone())
        .collect()
}

#[test]
fn an_ended_session_stops_heartbeating_at_once_and_leaves_after_the_grace() {
    let mut store = Store {
        registrations: vec![automatic("auto", 1), spawned("spawned", 2)],
        ..Store::default()
    };
    let none = HashSet::new();
    // Both sessions end: neither heartbeats any more, neither leaves yet.
    assert!(reconcile_lifecycle(&mut store, &none, &none, at("2026-10-01T12:00:00Z")).is_empty());
    assert!(heartbeating(&store).is_empty());
    assert!(present_registration_names(&store).is_empty());
    // Within the grace period, still kept.
    assert!(reconcile_lifecycle(&mut store, &none, &none, at("2026-10-01T12:04:59Z")).is_empty());
    // Past it, both leave.
    assert_eq!(
        reconcile_lifecycle(&mut store, &none, &none, at("2026-10-01T12:05:00Z")),
        ["auto", "spawned"]
    );
}

#[test]
fn a_brief_miss_keeps_the_registration_and_its_channel_comes_back() {
    let mut store = Store {
        registrations: vec![automatic("auto", 1), spawned("spawned", 2)],
        ..Store::default()
    };
    let none = HashSet::new();
    reconcile_lifecycle(&mut store, &none, &none, at("2026-10-01T12:00:00Z"));
    // A restart or sleep: back within the grace period.
    let all = targets(&store);
    assert!(reconcile_lifecycle(&mut store, &all, &all, at("2026-10-01T12:04:00Z")).is_empty());
    assert_eq!(
        heartbeating(&store),
        ["auto"],
        "a spawned agent's channel is its node's"
    );
    assert!(store
        .registrations
        .iter()
        .all(|r| r.missing_since.is_none()));
    // A later end starts the grace period again.
    assert!(reconcile_lifecycle(&mut store, &none, &none, at("2026-10-01T12:06:00Z")).is_empty());
}

#[test]
fn an_idle_session_is_still_running_and_stays() {
    // Discovery lists an idle session as live (a Claude Code prompt waiting
    // for input, a Codex thread between turns): nothing ends.
    let mut store = Store {
        registrations: vec![automatic("auto", 1), hand_added("manual", 2, false)],
        ..Store::default()
    };
    let live = targets(&store);
    for minute in ["12:00", "12:30", "18:00"] {
        let now = at(&format!("2026-10-01T{minute}:00Z"));
        assert!(reconcile_lifecycle(&mut store, &live, &live, now).is_empty());
    }
    assert_eq!(heartbeating(&store), ["auto", "manual"]);
}

#[test]
fn a_hand_added_agent_stays_registered_without_a_channel_until_its_session_runs() {
    let mut store = Store {
        registrations: vec![hand_added("manual", 1, false), hand_added("self", 2, true)],
        ..Store::default()
    };
    let none = HashSet::new();
    assert!(reconcile_lifecycle(&mut store, &none, &none, at("2026-10-01T12:00:00Z")).is_empty());
    // Weeks later: still registered, name and queue kept, never heartbeated.
    assert!(reconcile_lifecycle(&mut store, &none, &none, at("2026-10-30T12:00:00Z")).is_empty());
    assert_eq!(store.registrations.len(), 2);
    assert!(heartbeating(&store).is_empty());
    // Its session runs again: back on the relay at once.
    let live = targets(&store);
    reconcile_lifecycle(&mut store, &none, &live, at("2026-10-30T12:01:00Z"));
    assert_eq!(heartbeating(&store), ["manual", "self"]);
}

#[test]
fn only_automatic_and_spawned_agents_leave_by_themselves() {
    assert!(leaves_after_grace(&automatic("a", 1)));
    assert!(leaves_after_grace(&spawned("s", 2)));
    assert!(!leaves_after_grace(&hand_added("m", 3, false)));
    assert!(!leaves_after_grace(&hand_added("b", 4, true)));
}

#[tokio::test]
async fn an_unregistered_agent_leaves_the_push_status() {
    let temp = tempfile::tempdir().unwrap();
    let config = crate::relay::daemon::Config {
        paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: std::collections::BTreeMap::new(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: std::time::Duration::from_secs(3600),
        push_timing: crate::relay::push::PushTiming::default(),
        delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
    };
    let (core, _signals) = Core::new(config);
    core.store
        .update(|store| store.registrations.push(spawned("node-mirrored", 1)))
        .unwrap();
    core.hub.update(|status| {
        for name in ["gone", "released", "node-mirrored"] {
            status.push.insert(name.into(), PushState::Live);
        }
    });
    // An unregistered agent's last state must not read as connected; a
    // spawned one still registered keeps what its node mirrors.
    core.forget_stale_push(Vec::new());
    let push = core.hub.snapshot().push;
    assert_eq!(push.keys().collect::<Vec<_>>(), ["node-mirrored"]);
    // Every channel sync sweeps: with no node running here, the spawned
    // agent's mirrored state goes too.
    core.hub.update(|status| {
        status.push.insert("gone".into(), PushState::Live);
    });
    core.sync_agents().await;
    assert!(core.hub.snapshot().push.is_empty());
}

#[tokio::test]
async fn a_spawned_agent_this_core_has_not_seen_end_is_not_due() {
    let temp = tempfile::tempdir().unwrap();
    let config = crate::relay::daemon::Config {
        paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: std::collections::BTreeMap::new(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: std::time::Duration::from_secs(3600),
        push_timing: crate::relay::push::PushTiming::default(),
        delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
    };
    let (core, _signals) = Core::new(config);
    core.store
        .update(|store| {
            store.registrations.push(spawned("unseen", 1));
            store.registrations.push(automatic("auto", 2));
        })
        .unwrap();
    let due = core.settled_leavers(vec!["unseen".into(), "auto".into()]);
    assert_eq!(due, ["auto"]);
}

#[tokio::test]
async fn an_ended_agent_waits_for_the_final_answer_it_owes_for_up_to_an_hour() {
    let temp = tempfile::tempdir().unwrap();
    let config = crate::relay::daemon::Config {
        paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: std::collections::BTreeMap::new(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: std::time::Duration::from_secs(3600),
        push_timing: crate::relay::push::PushTiming::default(),
        delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
    };
    let (core, _signals) = Core::new(config);
    let recently = (chrono::Utc::now() - chrono::Duration::minutes(10))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    core.store
        .update(|store| {
            let mut owing = automatic("owing", 1);
            owing.missing_since = Some(recently.clone());
            let mut stale = automatic("stale", 2);
            stale.missing_since = Some("2026-01-01T00:00:00Z".into());
            for agent in ["agent-owing", "agent-stale"] {
                store.replies.get_or_insert_with(Vec::new).push(
                    serde_json::from_value(serde_json::json!({
                        "agentID": agent, "messageID": "m1",
                        "destination": {"thread": {"_0": "m1"}},
                    }))
                    .unwrap(),
                );
            }
            store.registrations.extend([owing, stale]);
        })
        .unwrap();
    // The owed answer holds one gone ten minutes; one gone for longer than
    // an hour leaves anyway.
    let due = core.settled_leavers(vec!["owing".into(), "stale".into()]);
    assert_eq!(due, ["stale"]);
}
