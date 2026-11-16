//! On a gate-only install a launch's one-time credential registers the
//! launched agent at relaygate, inside the launch and before the harness
//! starts. The agent acts with the `rg_` token that answers, which lives
//! in memory alone, is refreshed with itself, and is released when the
//! launch ends.

use super::*;
use crate::relay::agents::Renewal;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CREDENTIAL: &str = "sh_lt_fixture_one_time_launch";

/// One request the fake gate answered.
#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Value,
}

#[derive(Default)]
struct GateState {
    seen: Vec<Seen>,
    /// `METHOD /path` answered with this status and relaygate error code.
    refusals: HashMap<String, (u16, String)>,
    issued: u32,
}

/// A relaygate on loopback: registers and refreshes issue numbered `rg_`
/// tokens valid for an hour, a delete succeeds, and anything else answers
/// an empty list.
struct FakeGate {
    url: String,
    state: Arc<Mutex<GateState>>,
}

impl FakeGate {
    async fn start() -> FakeGate {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(GateState::default()));
        let shared = state.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(answer(stream, shared.clone()));
            }
        });
        FakeGate { url, state }
    }

    fn refuse(&self, request: &str, status: u16, code: &str) {
        self.state
            .lock()
            .unwrap()
            .refusals
            .insert(request.into(), (status, code.into()));
    }

    fn seen(&self, method: &str, path: &str) -> Vec<Seen> {
        let state = self.state.lock().unwrap();
        state
            .seen
            .iter()
            .filter(|seen| seen.method == method && seen.path.starts_with(path))
            .cloned()
            .collect()
    }

    fn all(&self) -> Vec<Seen> {
        self.state.lock().unwrap().seen.clone()
    }
}

async fn answer(mut stream: tokio::net::TcpStream, state: Arc<Mutex<GateState>>) {
    let mut request = Vec::new();
    let mut chunk = [0; 4096];
    let (head, body) = loop {
        let Ok(count) = stream.read(&mut chunk).await else {
            return;
        };
        if count == 0 {
            return;
        }
        request.extend_from_slice(&chunk[..count]);
        let text = String::from_utf8_lossy(&request).to_string();
        let Some(end) = text.find("\r\n\r\n") else {
            continue;
        };
        let length = text[..end]
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0);
        if request.len() >= end + 4 + length {
            break (text[..end].to_string(), text[end + 4..].to_string());
        }
    };
    let mut parts = head.lines().next().unwrap_or_default().split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let authorization = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then(|| value.trim().to_string())
    });
    let route = format!("{method} {}", path.split('?').next().unwrap_or_default());
    let (status, reply) = {
        let mut state = state.lock().unwrap();
        state.seen.push(Seen {
            method,
            path,
            authorization,
            body: serde_json::from_str(&body).unwrap_or(Value::Null),
        });
        let expires = (chrono::Utc::now() + chrono::TimeDelta::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        match state.refusals.get(&route).cloned() {
            Some((status, code)) => (
                status,
                json!({"ok": false, "error": {"code": code, "message": "no"}}),
            ),
            None if route == "POST /v1/register" => {
                state.issued += 1;
                let n = state.issued;
                (
                    200,
                    json!({"ok": true, "data": {"agent_id": format!("agent_gate_{n}"),
                        "gid": 4200 + n, "token": format!("rg_launch_{n}"),
                        "expires_at": expires, "user_id": "user_fake"}}),
                )
            }
            None if route == "POST /v1/token/refresh" => {
                state.issued += 1;
                let n = state.issued;
                (
                    200,
                    json!({"ok": true, "data": {"token": format!("rg_refreshed_{n}"),
                        "expires_at": expires}}),
                )
            }
            None => (200, json!({"ok": true, "data": []})),
        }
    };
    let body = reply.to_string();
    let reply = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// A core whose account's workspace is gate-only, at `gate`.
fn gate_core(home: &std::path::Path, spawner: Arc<FakeSpawner>, gate: &str) -> Arc<Core> {
    let core = core(home, spawner);
    core.store
        .update(|store| {
            store.cloud = Some(crate::relay::store::CloudWorkspace {
                key: Secret::default(),
                base_url: gate.into(),
                gate_url: Some(gate.into()),
                ..Default::default()
            })
        })
        .unwrap();
    core.rediscover_workspace();
    assert_eq!(
        core.workspace().and_then(|w| w.gate_url).as_deref(),
        Some(gate)
    );
    core
}

/// Spawns `name` with Control's launch credential, as `spawn:codex` asks.
async fn launch(core: &Arc<Core>, name: &str, credential: Option<&str>) -> Value {
    let mut input = json!({"name": name, "task": "build it"});
    if let Some(credential) = credential {
        input["launch_credential"] = json!(credential);
    }
    let frame = json!({"v": 1, "type": "action.invoke", "invocation_id": format!("inv_{name}"),
        "action": "spawn:codex", "caller_id": "agent_lead", "input": input});
    let Some(Ok(Invoke::Spawn(request))) = wire::invoke(&frame) else {
        panic!("not a spawn")
    };
    let (link, sent) = NodeLink::detached(node());
    let _frames = relaycast(link.clone(), sent);
    let answer = core.clone().answer_spawn(link, request).await;
    assert!(!answer.to_string().contains(CREDENTIAL), "{answer}");
    answer
}

/// The token `name` acts with, and where.
fn acting(core: &Core, name: &str) -> Option<(String, String)> {
    core.store.read(|s| {
        let (registration, token) = s.credential_named(name)?;
        Some((registration.base_url, token.expose().to_string()))
    })
}

fn launch_gate(core: &Core, name: &str) -> Option<crate::relay::store::LaunchGate> {
    core.store.launch_gates(|gates| gates.0.get(name).cloned())
}

/// Nothing under `home` holds a launch credential or an `rg_` token.
fn nothing_written(core: &Core, home: &std::path::Path) {
    core.store.flush().unwrap();
    let mut folders = vec![home.to_path_buf()];
    let mut files = 0;
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                folders.push(path);
            } else if let Ok(bytes) = std::fs::read(&path) {
                files += 1;
                let text = String::from_utf8_lossy(&bytes);
                assert!(
                    !text.contains("sh_lt_") && !text.contains("rg_"),
                    "{} keeps a launch credential or relaygate token",
                    path.display()
                );
            }
        }
    }
    assert!(files > 0, "the node wrote nothing to inspect");
}

#[tokio::test]
async fn a_launch_registers_at_the_gate_once_and_its_agent_acts_with_the_token() {
    let gate = FakeGate::start().await;
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = gate_core(home.path(), spawner.clone(), &gate.url);
    observed(&core);

    let answer = launch(&core, "lg1", Some(CREDENTIAL)).await;
    assert_eq!(
        answer,
        wire::action_output("inv_lg1", wire::spawned("lg1", Some(&core.config.home)))
    );
    // One register, with the credential as the bearer and the name alone.
    let registers = gate.seen("POST", "/v1/register");
    assert_eq!(registers.len(), 1, "{registers:?}");
    assert_eq!(
        registers[0].authorization.as_deref(),
        Some(format!("Bearer {CREDENTIAL}").as_str())
    );
    assert_eq!(registers[0].body, json!({"name": "lg1"}));
    // The credential went nowhere else, and the agent started without it.
    assert_eq!(
        gate.all()
            .iter()
            .filter(|seen| seen
                .authorization
                .as_deref()
                .is_some_and(|a| a.contains("sh_lt_")))
            .count(),
        1
    );
    assert_eq!(*spawner.credentials.lock().unwrap(), [None]);
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);

    // The registration is kept with the gate enrolments, and the agent's
    // deliveries and sends act at the gate with its rg_ token.
    let held = launch_gate(&core, "lg1").unwrap();
    assert_eq!(held.agent_id, "agent_gate_1");
    assert_eq!(held.gate_url, gate.url);
    assert_eq!(held.gate.recovery, None);
    assert_eq!(
        acting(&core, "lg1"),
        Some((gate.url.clone(), "rg_launch_1".into()))
    );
    assert_eq!(
        core.store
            .read(|s| s.token("lg1"))
            .map(|t| t.expose().to_string()),
        Some("rg_launch_1".into())
    );
    core.poll_once().await;
    let reads = gate.seen("GET", "/v1/deliveries");
    assert!(!reads.is_empty(), "{:?}", gate.all());
    assert!(
        reads
            .iter()
            .all(|seen| seen.authorization.as_deref() == Some("Bearer rg_launch_1")),
        "{reads:?}"
    );

    // A second registration of the name replaces the first.
    core.register_launch_at_gate(
        &gate.url,
        "lg1",
        "inv_lg1",
        Secret::new("sh_lt_second_launch"),
    )
    .await
    .unwrap();
    assert_eq!(gate.seen("POST", "/v1/register").len(), 2);
    assert_eq!(
        launch_gate(&core, "lg1").unwrap().token.expose(),
        "rg_launch_2"
    );
    assert_eq!(acting(&core, "lg1").unwrap().1, "rg_launch_2");
    assert!(gate.seen("DELETE", "/v1/agent").is_empty());

    nothing_written(&core, home.path());

    // Its release ends the registration at the gate with its own token.
    let released = core
        .clone()
        .answer_release(ReleaseRequest {
            invocation_id: "inv_r".into(),
            name: "lg1".into(),
            expected_agent_id: Some("agent_lg1".into()),
        })
        .await;
    assert_eq!(
        released,
        wire::action_output("inv_r", wire::released("lg1"))
    );
    let deleted = gate.seen("DELETE", "/v1/agent");
    assert_eq!(deleted.len(), 1);
    assert_eq!(
        deleted[0].authorization.as_deref(),
        Some("Bearer rg_launch_2")
    );
    assert!(launch_gate(&core, "lg1").is_none());
    nothing_written(&core, home.path());
}

#[tokio::test]
async fn a_launch_whose_process_exits_or_never_starts_releases_its_registration() {
    let gate = FakeGate::start().await;
    let home = tempfile::tempdir().unwrap();
    let core = gate_core(home.path(), Arc::new(FakeSpawner::default()), &gate.url);
    let observer = observed(&core);
    launch(&core, "lg2", Some(CREDENTIAL)).await;
    assert!(launch_gate(&core, "lg2").is_some());
    observer.set("lg2", ProcessLiveness::Exited, WorkState::Completed, false);
    core.observe_spawned().await;
    let deleted = gate.seen("DELETE", "/v1/agent");
    assert_eq!(deleted.len(), 1);
    assert_eq!(
        deleted[0].authorization.as_deref(),
        Some("Bearer rg_launch_1")
    );
    assert!(launch_gate(&core, "lg2").is_none());

    // A harness that does not start leaves no registration either.
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        refuse: true,
        ..FakeSpawner::default()
    });
    let core = gate_core(home.path(), spawner, &gate.url);
    let failed = launch(&core, "lg3", Some(CREDENTIAL)).await;
    assert!(failed["error"]
        .as_str()
        .unwrap()
        .starts_with("spawn_harness_unavailable"));
    let deleted = gate.seen("DELETE", "/v1/agent");
    assert_eq!(deleted.len(), 2);
    assert_eq!(
        deleted[1].authorization.as_deref(),
        Some("Bearer rg_launch_2")
    );
    assert!(launch_gate(&core, "lg3").is_none());
    assert!(core.store.read(|store| store.registrations.is_empty()));
}

#[tokio::test]
async fn each_gate_refusal_fails_the_launch_once_with_its_code() {
    for (status, code, prefix) in [
        (401, "relaygate_unauthenticated", "spawn_failed"),
        (403, "relaygate_denied", "spawn_failed"),
        (403, "relaygate_name_scope", "spawn_failed"),
        (409, "relaygate_name_taken", "spawn_agent_name_in_use"),
        (503, "relaygate_unavailable", "spawn_failed"),
    ] {
        let gate = FakeGate::start().await;
        gate.refuse("POST /v1/register", status, code);
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = gate_core(home.path(), spawner.clone(), &gate.url);
        let answer = launch(&core, "lg4", Some(CREDENTIAL)).await;
        let error = answer["error"].as_str().unwrap();
        assert!(error.starts_with(&format!("{prefix}: ")), "{error}");
        assert!(error.contains(&format!("({code})")), "{error}");
        assert!(!error.contains("rg_"), "{error}");
        // Presented once and never again, and nothing launched or kept.
        assert_eq!(gate.seen("POST", "/v1/register").len(), 1, "{code}");
        assert_eq!(
            gate.all()
                .iter()
                .filter(|seen| seen
                    .authorization
                    .as_deref()
                    .is_some_and(|a| a.contains("sh_lt_")))
                .count(),
            1,
            "{code}: {:?}",
            gate.all()
        );
        assert!(spawner.launched.lock().unwrap().is_empty());
        assert!(launch_gate(&core, "lg4").is_none());
        assert!(core.store.read(|store| store.registrations.is_empty()));
    }

    // A gate that cannot be reached fails it too, without a retry.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = gate_core(home.path(), spawner.clone(), &url);
    let answer = launch(&core, "lg5", Some(CREDENTIAL)).await;
    let error = answer["error"].as_str().unwrap();
    assert!(error.starts_with("spawn_failed: "), "{error}");
    assert!(error.contains("(unreachable)"), "{error}");
    assert!(spawner.launched.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_refresh_rotates_the_token_and_one_refused_ends_the_registration() {
    let gate = FakeGate::start().await;
    let home = tempfile::tempdir().unwrap();
    let core = gate_core(home.path(), Arc::new(FakeSpawner::default()), &gate.url);
    observed(&core);
    launch(&core, "lg6", Some(CREDENTIAL)).await;
    let first = launch_gate(&core, "lg6").unwrap();
    // Due at 80% of its hour.
    let issued = chrono::DateTime::parse_from_rfc3339(&first.gate.expires_at).unwrap();
    let renew = chrono::DateTime::parse_from_rfc3339(&first.gate.renew_at).unwrap();
    let left = (issued - renew).num_seconds();
    assert!((715..=725).contains(&left), "{left}");

    // relaygate refused the current token: it is refreshed with itself.
    let renewal = core
        .renew_gate_registration("lg6", Some(&first.token))
        .await;
    assert!(matches!(renewal, Renewal::Renewed));
    let refreshes = gate.seen("POST", "/v1/token/refresh");
    assert_eq!(refreshes.len(), 1);
    assert_eq!(
        refreshes[0].authorization.as_deref(),
        Some("Bearer rg_launch_1")
    );
    assert_eq!(acting(&core, "lg6").unwrap().1, "rg_refreshed_2");
    assert_eq!(gate.seen("POST", "/v1/register").len(), 1);
    nothing_written(&core, home.path());

    // A refresh relaygate refuses ends it: the agent needs a relaunch.
    gate.refuse("POST /v1/token/refresh", 401, "relaygate_unauthenticated");
    core.forget_gate_renewal("lg6");
    let current = launch_gate(&core, "lg6").unwrap().token;
    let renewal = core.renew_gate_registration("lg6", Some(&current)).await;
    assert!(matches!(renewal, Renewal::Stopped));
    assert!(launch_gate(&core, "lg6").is_none());
    let error = core.gate_error("lg6").unwrap();
    assert!(error.contains("Relaunch the agent"), "{error}");
    assert!(!error.contains("rg_"), "{error}");
    assert_eq!(gate.seen("POST", "/v1/register").len(), 1);
}

#[tokio::test]
async fn a_spawn_without_a_credential_never_calls_the_gate() {
    let gate = FakeGate::start().await;
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = gate_core(home.path(), spawner.clone(), &gate.url);
    observed(&core);
    launch(&core, "lg7", None).await;
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
    assert!(gate.seen("POST", "/v1/register").is_empty());
    assert!(launch_gate(&core, "lg7").is_none());
    assert_eq!(acting(&core, "lg7").unwrap().1, "at_live_lg7");
}

/// A launch registration is bound to the launch it was made for: a
/// same-named registration of another launch is never acted with by this
/// one's agent, and this launch's end never releases it.
#[tokio::test]
async fn a_launch_registration_belongs_to_its_own_launch_alone() {
    let gate = FakeGate::start().await;
    let home = tempfile::tempdir().unwrap();
    let core = gate_core(home.path(), Arc::new(FakeSpawner::default()), &gate.url);
    let observer = observed(&core);
    launch(&core, "lg8", Some(CREDENTIAL)).await;
    assert_eq!(acting(&core, "lg8").unwrap().1, "rg_launch_1");
    // Another launch of the name registers meanwhile.
    core.register_launch_at_gate(
        &gate.url,
        "lg8",
        "inv_another",
        Secret::new("sh_lt_another_launch"),
    )
    .await
    .unwrap();
    assert_eq!(acting(&core, "lg8"), None);
    // This launch's process ends: the other launch's registration stays,
    // and nothing is deleted with its token.
    observer.set("lg8", ProcessLiveness::Exited, WorkState::Completed, false);
    core.observe_spawned().await;
    assert!(gate.seen("DELETE", "/v1/agent").is_empty());
    assert_eq!(
        launch_gate(&core, "lg8").unwrap().token.expose(),
        "rg_launch_2"
    );
}

/// A launched agent's relaygate registration lives in memory alone: after
/// a restart the agent acts with no token (never the one saved beside it),
/// and is reported once as needing a relaunch. Only a marker is saved.
#[tokio::test]
async fn a_restart_leaves_a_launched_agent_without_a_token_and_says_so() {
    let gate = FakeGate::start().await;
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = gate_core(home.path(), spawner.clone(), &gate.url);
    observed(&core);
    launch(&core, "lg9", Some(CREDENTIAL)).await;
    assert_eq!(acting(&core, "lg9").unwrap().1, "rg_launch_1");
    nothing_written(&core, home.path());
    let store = core.config.app_data_dir.join("injectable-agents.json");
    let saved = std::fs::read_to_string(&store).unwrap();
    assert!(saved.contains("\"gateLaunch\": true"), "{saved}");

    let restarted = gate_core(home.path(), spawner, &gate.url);
    observed(&restarted);
    assert!(launch_gate(&restarted, "lg9").is_none());
    assert_eq!(acting(&restarted, "lg9"), None);
    assert_eq!(restarted.store.read(|s| s.token("lg9")), None);
    restarted.poll_once().await;
    let error = restarted.gate_error("lg9").unwrap();
    assert!(error.contains("Relaunch the agent"), "{error}");
    // Nothing reached the gate with any other token.
    assert!(gate
        .all()
        .iter()
        .all(|seen| seen.authorization.as_deref() != Some("Bearer at_live_lg9")));
}

/// Removing a launched agent of a gate-only install needs no workspace key:
/// it is taken off this computer and its relaygate registration is ended
/// with its own token.
#[tokio::test]
async fn removing_a_launched_agent_ends_its_registration_without_a_key() {
    let gate = FakeGate::start().await;
    let home = tempfile::tempdir().unwrap();
    let core = gate_core(home.path(), Arc::new(FakeSpawner::default()), &gate.url);
    observed(&core);
    launch(&core, "lg10", Some(CREDENTIAL)).await;
    core.unregister("lg10").await.unwrap();
    assert!(core.store.read(|s| s.registration_named("lg10").is_none()));
    assert!(launch_gate(&core, "lg10").is_none());
    let deleted = gate.seen("DELETE", "/v1/agent");
    assert_eq!(deleted.len(), 1);
    assert_eq!(
        deleted[0].authorization.as_deref(),
        Some("Bearer rg_launch_1")
    );
}

/// A launched agent whose process ended while it still owes an automatic
/// answer keeps its relaygate registration, so the answer can go out; it
/// is released when the agent leaves.
#[tokio::test]
async fn an_ended_launch_that_owes_an_answer_keeps_its_registration() {
    let gate = FakeGate::start().await;
    let home = tempfile::tempdir().unwrap();
    let core = gate_core(home.path(), Arc::new(FakeSpawner::default()), &gate.url);
    let observer = observed(&core);
    launch(&core, "lg11", Some(CREDENTIAL)).await;
    let agent_id = core
        .store
        .read(|s| s.registration_named("lg11").map(|r| r.agent_id.clone()))
        .unwrap();
    core.store
        .update(|s| {
            s.replies
                .get_or_insert_with(Vec::new)
                .push(crate::relay::spawn::report_back::owed(
                    &agent_id, "msg_owed", "lead",
                ))
        })
        .unwrap();
    observer.set("lg11", ProcessLiveness::Exited, WorkState::Completed, false);
    core.observe_spawned().await;
    assert!(gate.seen("DELETE", "/v1/agent").is_empty());
    assert_eq!(acting(&core, "lg11").unwrap().1, "rg_launch_1");
    // It leaves: the registration is released with its own token.
    core.unregister("lg11").await.unwrap();
    let deleted = gate.seen("DELETE", "/v1/agent");
    assert_eq!(deleted.len(), 1);
    assert_eq!(
        deleted[0].authorization.as_deref(),
        Some("Bearer rg_launch_1")
    );
}
