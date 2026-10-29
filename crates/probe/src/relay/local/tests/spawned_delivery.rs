//! The real registered-delivery/router/proxy path with an unloaded Codex.
use super::*;
use crate::relay::codex::app_server::tests::{server_frame, FakeAppServer};
use crate::relay::codex::runner::tests::FakeRunner;
use crate::relay::store::{Registration, SpawnOrigin};
use serde_json::json;

#[test]
fn native_spawn_followup_resumes_after_codex_unloads_the_idle_thread() {
    let world = world();
    let config = world.sessions.config.clone();
    seed_codex_thread(&config.codex.home, THREAD);
    world.table.insert(
        600,
        FakeProcess {
            executable: Some(codex_exe()),
            arguments: vec!["codex".into(), "app-server".into()],
            ..process(1, 600)
        },
    );
    let runner = Arc::new(FakeRunner::default());
    let server = || {
        FakeAppServer::new(|request| {
            let result = match request["method"].as_str()? {
                "thread/loaded/list" => json!({"data": [], "nextCursor": null}),
                // The production client does not opt into experimentalApi, so
                // Codex rejects experimental resume fields such as `path`.
                "thread/resume" if request["params"].get("path").is_some() => {
                    return Some(server_frame(&json!({"id": request["id"],
                        "error": {"message": "thread/resume.path requires experimentalApi"}})));
                }
                "thread/resume" => json!({"thread": {"id": THREAD}}),
                "turn/start" => json!({"turn": {"id": "followup"}}),
                _ => return None,
            };
            Some(server_frame(
                &json!({"id": request["id"], "result": result}),
            ))
        })
    };
    let ordinary = server();
    let ordinary_seen = ordinary.seen.clone();
    let spawned = server();
    let spawned_seen = spawned.seen.clone();
    runner.streams.lock().unwrap().extend([
        Box::new(ordinary) as Box<dyn crate::relay::codex::runner::ProxyStream>,
        Box::new(spawned),
    ]);
    let routes = Arc::new(SystemCodexRoutes::with_runner(
        config.codex.clone(),
        world.table.clone(),
        UID,
        runner.clone(),
    ));
    let injector = LocalInjector::new(
        config.clone(),
        world.table.clone(),
        CodexRouter::new(routes),
        ServingPath::default(),
    );
    let mut registration: Registration = serde_json::from_value(json!({
        "name": "spawned", "agentID": "agent-1", "target": {"kind": "codex", "id": THREAD},
        "title": "worker", "baseURL": "https://example.test", "registeredAt": "2026-10-17T15:15:45Z"
    }))
    .unwrap();
    assert_eq!(
        injector.inject_registered(&registration, "d", "m", "PING-2"),
        InjectOutcome::Waiting(codex::router::NOT_RUNNING.into())
    );
    assert!(!ordinary_seen
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "thread/resume"));
    registration.spawn = Some(
        serde_json::from_value::<SpawnOrigin>(json!({
            "nodeID": "node-1", "nodeName": "desktop", "invocationID": "inv-1", "harness": "codex"
        }))
        .unwrap(),
    );
    assert_eq!(
        injector.inject_registered(&registration, "d", "m", "PING-2"),
        InjectOutcome::Delivered
    );
    let seen = spawned_seen.lock().unwrap();
    let methods: Vec<_> = seen.iter().filter_map(|r| r["method"].as_str()).collect();
    assert_eq!(
        methods,
        [
            "initialize",
            "initialized",
            "thread/loaded/list",
            "thread/resume",
            "turn/start"
        ]
    );
    assert_eq!(
        seen[3]["params"],
        json!({"threadId": THREAD, "excludeTurns": true})
    );
    assert_eq!(seen[4]["params"]["threadId"], THREAD);
    assert_eq!(seen[4]["params"]["clientUserMessageId"], "m");
    assert_eq!(seen[4]["params"]["input"][0]["text"], "PING-2");
    drop(seen);
    let proxies = runner.proxies.lock().unwrap().len();
    let db = rusqlite::Connection::open(config.codex.home.join("state_5.sqlite")).unwrap();
    db.execute("update threads set archived = 1", []).unwrap();
    assert_eq!(
        injector.inject_registered(&registration, "d2", "m2", "again"),
        InjectOutcome::Waiting(codex::router::NOT_RUNNING.into())
    );
    assert_eq!(
        runner.proxies.lock().unwrap().len(),
        proxies,
        "archived spawns never resume"
    );
}
