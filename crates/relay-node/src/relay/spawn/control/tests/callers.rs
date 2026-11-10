//! Spawn controls called by external callers bound on their bridge
//! connection through the `SpawnCallers` plugin, and the session path with
//! and without it.
use super::*;
use crate::relay::daemon::{Config, Permit, Plugins};
use crate::relay::delivery::DeliveryTiming;
use crate::relay::paths::CorePaths;
use crate::relay::push::PushTiming;
use crate::relay::server;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;

/// The bridge connection the stub binds its caller on.
const BOUND: CallContext = CallContext {
    peer_pid: Some(42),
    connection_id: Some(1),
};
const IDEMPOTENCY: &str = "release-test-20261107-0001";

/// A Relaycast stand-in that answers each request with the next body and
/// keeps what it was asked.
struct Relaycast {
    listener: TcpListener,
    base: String,
}

impl Relaycast {
    fn new() -> Relaycast {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        Relaycast { listener, base }
    }

    /// Serves one request per body, on a thread; the handle returns the
    /// requests as text.
    fn serve(&self, bodies: Vec<Value>) -> std::thread::JoinHandle<Vec<String>> {
        self.serve_statuses(
            bodies
                .into_iter()
                .map(|body| ("200 OK", json!({"ok": true, "data": body})))
                .collect(),
        )
    }

    fn serve_statuses(
        &self,
        responses: Vec<(&'static str, Value)>,
    ) -> std::thread::JoinHandle<Vec<String>> {
        let listener = self.listener.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_request(&mut stream));
                let body = body.to_string();
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
            requests
        })
    }

    /// Whether nothing connected.
    fn untouched(&self) -> bool {
        self.listener.set_nonblocking(true).unwrap();
        let untouched = matches!(
            self.listener.accept(),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
        );
        self.listener.set_nonblocking(false).unwrap();
        untouched
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut buffer = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let count = stream.read(&mut chunk).unwrap();
        buffer.extend_from_slice(&chunk[..count]);
        let text = String::from_utf8_lossy(&buffer).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let length = text[..end]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if buffer.len() >= end + 4 + length {
                return text;
            }
        }
        if count == 0 {
            return text;
        }
    }
}

fn request_body(request: &str) -> Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

/// A plugin that binds one caller on connection 1 (or resolves it however a
/// test says) and logs what it is asked. Any other connection is not a
/// service caller's.
struct Stub {
    connections: Mutex<HashMap<u64, ConnectionCaller>>,
    admit: Option<RpcError>,
    record: Mutex<Option<RpcError>>,
    /// Every outcome `record` saw, as the caller would read it.
    recorded: Mutex<Vec<Result<Value, RpcError>>>,
    log: Mutex<Vec<String>>,
}

impl Stub {
    fn new(caller: ExternalCaller) -> Arc<Stub> {
        Stub::resolving(ConnectionCaller::Bound(caller))
    }

    fn resolving(resolution: ConnectionCaller) -> Arc<Stub> {
        Arc::new(Stub {
            connections: Mutex::new(HashMap::from([(1, resolution)])),
            admit: None,
            record: Mutex::new(None),
            recorded: Mutex::new(Vec::new()),
            log: Mutex::new(Vec::new()),
        })
    }

    fn admitting(caller: ExternalCaller, admit: RpcError) -> Arc<Stub> {
        Arc::new(Stub {
            admit: Some(admit),
            ..Arc::into_inner(Stub::new(caller)).unwrap()
        })
    }

    fn set(&self, connection: u64, resolution: ConnectionCaller) {
        self.connections
            .lock()
            .unwrap()
            .insert(connection, resolution);
    }

    fn fail_record(&self, error: Option<RpcError>) {
        *self.record.lock().unwrap() = error;
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn recorded(&self) -> Vec<Result<Value, RpcError>> {
        self.recorded.lock().unwrap().clone()
    }
}

impl SpawnCallers for Stub {
    fn connection(&self, context: &CallContext) -> ConnectionCaller {
        let id = context
            .connection_id
            .expect("the core's own calls are never resolved");
        self.log.lock().unwrap().push(format!("connection:{id}"));
        self.connections
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .unwrap_or(ConnectionCaller::NotExternal)
    }

    fn admit(&self, caller: &ExternalCaller, call: &SpawnCall<'_>) -> Result<Permit, RpcError> {
        let (method, named) = match call.request {
            SpawnRequest::Invoke(p) => ("invoke", p.caller_name.is_some()),
            SpawnRequest::Status(p) => ("status", p.caller_name.is_some()),
            SpawnRequest::Release(p) => ("release", p.caller_name.is_some()),
        };
        assert!(!named, "a bound call never names a session caller");
        assert_eq!(call.connection_id, Some(1));
        self.log.lock().unwrap().push(format!(
            "admit:{method}:{}:{:?}",
            caller.agent_id, call.peer_pid
        ));
        match &self.admit {
            Some(error) => Err(error.clone()),
            None => Ok(Permit::new(method.to_string())),
        }
    }

    fn record(
        &self,
        permit: Permit,
        outcome: &Result<SpawnControlInvocation, RpcError>,
    ) -> Result<(), RpcError> {
        let method = permit.downcast::<String>().unwrap();
        self.recorded.lock().unwrap().push(
            outcome
                .as_ref()
                .map(|receipt| serde_json::to_value(receipt).unwrap())
                .map_err(Clone::clone),
        );
        let outcome = match outcome {
            Ok(_) => "ok".to_string(),
            Err(error) => serde_json::to_value(error.data.kind).unwrap().to_string(),
        };
        self.log
            .lock()
            .unwrap()
            .push(format!("record:{method}:{}", outcome.trim_matches('"')));
        match self.record.lock().unwrap().clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// `method` called over the connection the stub binds its caller on.
async fn bound(core: &Arc<Core>, method: &str, params: Value) -> Result<Value, RpcError> {
    server::call_from(core, &BOUND, method, params).await
}

fn service(owns_only: bool) -> ExternalCaller {
    ExternalCaller {
        agent_id: "agent_service".into(),
        name: "flows-test".into(),
        token: Secret::new("service-agent-token"),
        harnesses: None,
        directory_roots: None,
        owns_only,
    }
}

fn core_with(plugin: Option<Arc<dyn SpawnCallers>>, base: &str) -> (tempfile::TempDir, Arc<Core>) {
    let temp = tempfile::tempdir().unwrap();
    let core = core_at(temp.path(), plugin, base);
    (temp, core)
}

fn core_at(home: &std::path::Path, plugin: Option<Arc<dyn SpawnCallers>>, base: &str) -> Arc<Core> {
    let config = Config {
        paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: std::time::Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    let plugins = Plugins {
        spawn_callers: plugin,
        ..Plugins::default()
    };
    let core = Core::with_plugins(config, plugins).0;
    *core.workspace.lock().unwrap() = Some(Workspace {
        base_url: base.into(),
        workspace_id: Some("rw_test".into()),
        ..selected_workspace()
    });
    core
}

/// The session caller `test-caller` and a worker it can see, spawned on
/// this computer at the request of `requester`.
fn seed(core: &Core, base: &str, requester: Option<&str>) {
    seed_worker(core, base, requester, None);
}

fn seed_worker(core: &Core, base: &str, requester: Option<&str>, missing_since: Option<&str>) {
    let mut session = registered();
    session.base_url = base.into();
    let mut worker = session.clone();
    worker.name = "test-worker".into();
    worker.agent_id = "agent_worker".into();
    let mut spawn = json!({"nodeID":"node_local","nodeName":"test-desktop","invocationID":"invocation_1","harness":"claude"});
    if let Some(requester) = requester {
        spawn["requester"] = json!({"name": "someone", "agentID": requester});
    }
    worker.spawn = Some(serde_json::from_value(spawn).unwrap());
    worker.missing_since = missing_since.map(Into::into);
    core.store
        .update(|store| {
            store.registrations.push(session);
            store.registrations.push(worker);
            store
                .tokens
                .insert("test-caller".into(), Secret::new("test-agent-secret"));
        })
        .unwrap();
}

/// Release parameters: the session caller's, or a bound caller's (which
/// name no caller).
fn release_params(external: bool) -> Value {
    let mut params = json!({"caller_name":"test-caller","node_id":"node_local","node_name":"test-desktop","name":"test-worker","expected_agent_id":"agent_worker","idempotency_key": IDEMPOTENCY});
    if external {
        params.as_object_mut().unwrap().remove("caller_name");
    }
    params
}

fn status_params(external: bool) -> Value {
    let mut params =
        json!({"caller_name":"test-caller","action":"release","invocation_id":"invocation_9"});
    if external {
        params.as_object_mut().unwrap().remove("caller_name");
    }
    params
}

/// A bound caller's invoke parameters.
fn invoke_params(core: &Core, harness: &str, directory: &str) -> Value {
    json!({"node_id":"node_local","node_name": crate::relay::spawn::node_name(&core.machine_prefix),"name":"test-new-worker","harness": harness,"task":"do the thing","directory": directory,"idempotency_key":"spawn-test-20261107-0001"})
}

fn released() -> Value {
    json!({
        "id":"invocation_release",
        "status":"completed",
        "output":{"released":true,"name":"test-worker"}
    })
}

fn strict_pending() -> Value {
    json!({
        "id": "invocation_new",
        "status": "pending",
        "spawn_contract_applied": "relay.spawn.invoke.logical-replay-resume/1",
        "spawn_replay_capability_applied": "relay.spawn.replay-resume/1",
    })
}

fn reason(error: &RpcError) -> Option<RefusalReason> {
    error.data.reason
}

fn assert_class(error: &RpcError, kind: ErrorKind, class: &str, reason: Option<RefusalReason>) {
    assert_eq!(error.code, -32000, "{error:?}");
    assert_eq!(error.message, class, "{error:?}");
    assert_eq!(error.data.kind, kind, "{error:?}");
    assert_eq!(error.data.reason, reason, "{error:?}");
    assert!(!error.data.retryable, "{error:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_caller_secret_is_refused_on_every_spawn_method_before_anything_else() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, plain) = core_with(None, &relaycast.base);
    let (_plugin_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    for core in [&plain, &core] {
        seed(core, &relaycast.base, Some("agent_caller"));
        let directory = std::env::temp_dir();
        let mut invoke = invoke_params(core, "claude", directory.to_str().unwrap());
        invoke["caller_name"] = json!("test-caller");
        for (method, mut params) in [
            ("spawn.invoke", invoke),
            ("spawn.status", status_params(false)),
            ("spawn.release", release_params(false)),
            ("spawn.release", release_params(true)),
        ] {
            // Any value, even an empty or malformed one, and whatever else
            // the params carry: the key alone is refused.
            for secret in [json!("s"), json!(""), json!(null), json!(7)] {
                params["caller_secret"] = secret;
                for context in [CallContext::default(), BOUND] {
                    let error = server::call_from(core, &context, method, params.clone())
                        .await
                        .unwrap_err();
                    assert_class(
                        &error,
                        ErrorKind::Refused,
                        "legacy_credential_refused",
                        None,
                    );
                }
            }
            params["unknown"] = json!(true);
            let error = bound(core, method, params).await.unwrap_err();
            assert_class(
                &error,
                ErrorKind::Refused,
                "legacy_credential_refused",
                None,
            );
        }
    }
    assert!(stub.log().is_empty(), "{:?}", stub.log());
    assert!(relaycast.untouched());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bound_connection_may_not_name_a_session_caller() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(false));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_caller"));
    for (method, params) in [
        ("spawn.status", status_params(false)),
        ("spawn.release", release_params(false)),
    ] {
        let error = bound(&core, method, params).await.unwrap_err();
        assert_class(
            &error,
            ErrorKind::Refused,
            "legacy_credential_refused",
            None,
        );
    }
    assert_eq!(stub.log(), ["connection:1", "connection:1"]);
    assert!(relaycast.untouched());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_naming_no_caller_on_an_unbound_connection_is_caller_unbound() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, plain) = core_with(None, &relaycast.base);
    let (_plugin_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    let unknown = CallContext {
        peer_pid: Some(9),
        connection_id: Some(2),
    };
    for (core, context) in [
        (&plain, CallContext::default()),
        (&plain, BOUND),
        (&core, CallContext::default()),
        (&core, unknown),
    ] {
        seed(core, &relaycast.base, Some("agent_caller"));
        for (method, params) in [
            ("spawn.status", status_params(true)),
            ("spawn.release", release_params(true)),
            ("spawn.status", json!(null)),
        ] {
            let error = server::call_from(core, &context, method, params)
                .await
                .unwrap_err();
            assert_class(
                &error,
                ErrorKind::Refused,
                "caller_unbound",
                Some(RefusalReason::ServiceUnknown),
            );
        }
        // Params that are not an object are invalid before anything else.
        let error = server::call_from(core, &context, "spawn.status", json!(["x"]))
            .await
            .unwrap_err();
        assert_eq!(error.code, -32602);
    }
    assert_eq!(stub.log(), ["connection:2"; 3]);
    assert!(relaycast.untouched());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_connection_is_answered_with_the_plugins_class() {
    let relaycast = Relaycast::new();
    let classes = [
        RpcError::refused_because(RefusalReason::ServiceUnknown, "caller_unbound"),
        RpcError::new(ErrorKind::RateLimited, "auth_locked"),
        RpcError::refused_because(RefusalReason::ServiceExpired, "binding_stale"),
        RpcError::new(ErrorKind::Refused, "connection_closed"),
        RpcError::refused_because(RefusalReason::ServiceDisabled, "refused"),
        RpcError::refused_because(RefusalReason::WorkspaceMismatch, "refused"),
    ];
    for class in classes {
        let stub = Stub::resolving(ConnectionCaller::Refused(class.clone()));
        let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
        seed(&core, &relaycast.base, Some("agent_service"));
        // Naming the session caller does not reach the session path either.
        for params in [release_params(true), release_params(false)] {
            let error = bound(&core, "spawn.release", params).await.unwrap_err();
            assert_eq!(error, class);
        }
        assert!(relaycast.untouched());
        assert_eq!(stub.log(), ["connection:1", "connection:1"]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bound_caller_without_a_usable_token_is_refused() {
    let relaycast = Relaycast::new();
    for caller in [
        ExternalCaller {
            token: Secret::new(""),
            ..service(false)
        },
        ExternalCaller {
            agent_id: "agent/../x".into(),
            ..service(false)
        },
    ] {
        let stub = Stub::new(caller);
        let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
        let error = bound(&core, "spawn.status", status_params(true))
            .await
            .unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::Refused);
        assert_eq!(stub.log(), ["connection:1"]);
        assert!(relaycast.untouched());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn session_callers_are_unchanged_when_a_plugin_is_present() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_other"));
    let workspace = core.workspace().unwrap();
    // The registration rules of `only_an_active_exact_workspace_registration_can_act`.
    let session = |name: &str| {
        caller_in(
            &core,
            &workspace,
            Resolved::Session { recheck: None },
            Some(name),
        )
    };
    assert!(matches!(
        session("test-caller").unwrap(),
        Caller::Session { ref agent_id, ref token, .. }
            if agent_id == "agent_caller" && token.expose() == "test-agent-secret"
    ));
    assert!(session("other-caller").is_err());
    for wrong in [
        Workspace {
            key: Secret::new("other-secret"),
            ..workspace.clone()
        },
        Workspace {
            base_url: "https://other.example".into(),
            ..workspace.clone()
        },
    ] {
        assert!(caller_in(
            &core,
            &wrong,
            Resolved::Session { recheck: None },
            Some("test-caller")
        )
        .is_err());
    }
    // Invoke, status and release by the session caller take today's path: its own
    // token, no plugin call, and no owner check on a worker another
    // requester started.
    let node_name = crate::relay::spawn::node_name(&core.machine_prefix);
    let target = json!({
        "id":"node_local", "name":node_name, "live":true, "handlers_live":true,
        "active_agents":0, "reserved_agents":0, "max_agents":4,
        "capabilities":["spawn:codex"]
    });
    let served = relaycast.serve(vec![
        json!([target.clone()]),
        json!({"id":"invocation_session","status":"pending"}),
        json!([target]),
        json!({"id":"invocation_session","status":"pending"}),
        json!({"id":"invocation_9","status":"completed"}),
        released(),
    ]);
    let directory = tempfile::tempdir().unwrap();
    let mut invoke = invoke_params(&core, "codex", directory.path().to_str().unwrap());
    invoke["caller_name"] = json!("test-caller");
    server::call(&core, "spawn.invoke", invoke.clone())
        .await
        .unwrap();
    server::call(&core, "spawn.invoke", invoke).await.unwrap();
    server::call(&core, "spawn.status", status_params(false))
        .await
        .unwrap();
    server::call(&core, "spawn.release", release_params(false))
        .await
        .unwrap();
    let requests = served.join().unwrap();
    assert!(requests[0].starts_with("GET /v1/nodes?"));
    assert!(requests[1].starts_with("POST /v1/actions/spawn/invoke "));
    assert!(requests[2].starts_with("GET /v1/nodes?"));
    assert!(requests[3].starts_with("POST /v1/actions/spawn/invoke "));
    let first_invoke = request_body(&requests[1]);
    let retry_invoke = request_body(&requests[3]);
    assert_eq!(first_invoke, retry_invoke);
    assert!(first_invoke["input"].get("target_node_id").is_none());
    assert!(first_invoke["input"].get("spawn_contract").is_none());
    assert!(first_invoke["input"].get("logical_request").is_none());
    assert!(requests[4].starts_with("GET /v1/actions/release/invocations/invocation_9 "));
    assert!(requests[5].starts_with("POST /v1/agents/release-exact "));
    for index in [1, 3, 4, 5] {
        assert!(requests[index].contains("test-agent-secret"));
    }
    for index in [0, 2] {
        assert!(requests[index].contains("test-workspace-secret"));
    }
    assert!(stub.log().is_empty(), "{:?}", stub.log());
    // Over a bridge connection the plugin does not know, the same: the
    // plugin is asked once up front and once before the side effect.
    let session_connection = CallContext {
        peer_pid: Some(9),
        connection_id: Some(2),
    };
    let served = relaycast.serve(vec![json!({"id":"invocation_9","status":"completed"})]);
    server::call_from(
        &core,
        &session_connection,
        "spawn.status",
        status_params(false),
    )
    .await
    .unwrap();
    assert!(served.join().unwrap()[0].contains("test-agent-secret"));
    assert_eq!(stub.log(), ["connection:2", "connection:2"]);
    core.store
        .update(|store| store.registrations[0].archived_at = Some("2026-11-07T01:00:00Z".into()))
        .unwrap();
    assert!(session("test-caller").is_err());
}

fn claim_digest(workspace: &Workspace, caller_id: &str) -> String {
    let scope = json!([
        workspace.base_url,
        workspace.key.expose(),
        caller_id,
        IDEMPOTENCY
    ]);
    format!("{:x}", Sha256::digest(scope.to_string().as_bytes()))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_external_caller_uses_its_own_token_and_agent_id_for_release_claims() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(false));
    let (home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_other"));
    let served = relaycast.serve(vec![released()]);
    let answer = bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap();
    assert_eq!(answer["id"], "invocation_release");
    assert_eq!(answer["released"], true);
    let requests = served.join().unwrap();
    assert!(requests[0].contains("service-agent-token"));
    assert!(!requests[0].contains("test-agent-secret"));
    let claims = home.path().join("app-data").join("spawn-control-releases");
    let workspace = core.workspace().unwrap();
    assert!(claims
        .join(format!(
            "{}.json",
            claim_digest(&workspace, "agent_service")
        ))
        .is_file());
    assert!(!claims
        .join(format!("{}.json", claim_digest(&workspace, "agent_caller")))
        .exists());
    assert_eq!(
        stub.log(),
        [
            "connection:1",
            "admit:release:agent_service:Some(42)",
            "record:release:ok"
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_old_unrestricted_claim_cannot_bypass_a_new_owns_only_policy() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub), &relaycast.base);
    let workspace = core.workspace().unwrap();
    let params: SpawnReleaseParams = serde_json::from_value(release_params(false)).unwrap();
    claims::release(
        &core.config.app_data_dir,
        &workspace,
        "agent_service",
        &params,
        true,
        claims::Ownership::Unrestricted,
    )
    .unwrap();
    let error = bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Refused);
    assert_eq!(error.data.reason, Some(RefusalReason::NotOwner));
    assert!(relaycast.untouched());
}

#[test]
fn fresh_owner_proof_upgrades_an_unrestricted_claim_for_later_retries() {
    let home = tempfile::tempdir().unwrap();
    let workspace = selected_workspace();
    let params: SpawnReleaseParams = serde_json::from_value(release_params(false)).unwrap();
    claims::release(
        home.path(),
        &workspace,
        "agent_service",
        &params,
        true,
        claims::Ownership::Unrestricted,
    )
    .unwrap();
    claims::release(
        home.path(),
        &workspace,
        "agent_service",
        &params,
        true,
        claims::Ownership::Verified,
    )
    .unwrap();
    // The local registration may be gone on a later retry. The saved proof
    // still applies only to this exact caller, idempotency key and identity.
    claims::release(
        home.path(),
        &workspace,
        "agent_service",
        &params,
        false,
        claims::Ownership::ClaimOnly,
    )
    .unwrap();
    assert!(home
        .path()
        .join("spawn-control-releases")
        .join(format!(
            "{}.verified.json",
            claim_digest(&workspace, "agent_service")
        ))
        .is_file());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_owns_only_caller_cannot_release_an_agent_another_requester_started() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_other"));
    let workspace = core.workspace().unwrap();
    let params: SpawnReleaseParams = serde_json::from_value(release_params(false)).unwrap();
    assert!(core
        .store
        .read(|store| release_target(store, &workspace, &params)));
    let error = bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Refused);
    assert_eq!(reason(&error), Some(RefusalReason::NotOwner));
    assert!(!error.data.retryable);
    assert!(relaycast.untouched());
    assert_eq!(
        stub.log(),
        [
            "connection:1",
            "admit:release:agent_service:Some(42)",
            "record:release:refused"
        ]
    );
    // A worker with no recorded requester is not the caller's either.
    let (_none_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, None);
    let served = relaycast.serve(vec![
        json!({"caller_name":"someone","caller_id":"agent_other"}),
    ]);
    let error = bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap_err();
    assert_eq!(reason(&error), Some(RefusalReason::NotOwner));
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /v1/actions/spawn/invocations/invocation_1 "));
    // Without the plugin, the session caller releases it as before.
    let (_other_home, plain) = core_with(None, &relaycast.base);
    seed(&plain, &relaycast.base, Some("agent_other"));
    let served = relaycast.serve(vec![released()]);
    server::call(&plain, "spawn.release", release_params(false))
        .await
        .unwrap();
    assert!(served.join().unwrap()[0].contains("test-agent-secret"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_owns_only_caller_revalidates_a_missing_requester_before_release() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub), &relaycast.base);
    seed(&core, &relaycast.base, None);
    let served = relaycast.serve(vec![
        json!({"caller_name":"flows-test","caller_id":"agent_service"}),
        released(),
    ]);
    bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap();
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("GET /v1/actions/spawn/invocations/invocation_1 "));
    assert!(requests[0].contains("test-workspace-secret"));
    assert!(requests[1].starts_with("POST /v1/agents/release-exact "));
    assert!(requests[1].contains("service-agent-token"));
}

#[test]
fn an_owns_only_caller_releases_its_crashed_worker() {
    let workspace = selected_workspace();
    let mut worker = registered();
    worker.name = "test-worker".into();
    worker.agent_id = "agent_worker".into();
    worker.spawn = Some(serde_json::from_value(json!({"nodeID":"node_local","nodeName":"test-desktop","invocationID":"invocation_1","harness":"claude","requester":{"name":"flows-test","agentID":"agent_service"}})).unwrap());
    worker.missing_since = Some("2026-11-07T01:00:00Z".into());
    let mut store = Store::default();
    store.registrations.push(worker);
    let params = |name: &str, agent: &str, node: &str| SpawnReleaseParams {
        caller_name: None,
        node_id: node.into(),
        node_name: "test-desktop".into(),
        name: name.into(),
        expected_agent_id: agent.into(),
        idempotency_key: IDEMPOTENCY.into(),
    };
    let exact = params("test-worker", "agent_worker", "node_local");
    assert_eq!(
        release_target_ownership(&store, &workspace, &exact, "agent_service"),
        Some(ReleaseOwnership::Owned)
    );
    assert_eq!(
        release_target_ownership(&store, &workspace, &exact, "agent_other"),
        Some(ReleaseOwnership::Other)
    );
    for wrong in [
        params("test-worker", "agent_other", "node_local"),
        params("test-other", "agent_worker", "node_local"),
        params("test-worker", "agent_worker", "node_remote"),
    ] {
        assert_eq!(
            release_target_ownership(&store, &workspace, &wrong, "agent_service"),
            None
        );
    }
    let other_workspace = Workspace {
        key: Secret::new("another-workspace"),
        ..workspace
    };
    assert_eq!(
        release_target_ownership(&store, &other_workspace, &exact, "agent_service"),
        None
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_owns_only_caller_releases_its_own_worker_end_to_end() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed_worker(
        &core,
        &relaycast.base,
        Some("agent_service"),
        Some("2026-11-07T01:00:00Z"),
    );
    let served = relaycast.serve(vec![released()]);
    bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap();
    assert!(served.join().unwrap()[0].contains("service-agent-token"));
    assert_eq!(stub.log().last().unwrap(), "record:release:ok");
}

#[test]
fn refusal_reasons_serialize_and_old_errors_omit_reason() {
    use crate::relay::protocol::ErrorData;
    let plain = serde_json::to_value(RpcError::new(ErrorKind::Refused, "no")).unwrap();
    assert!(plain["data"].get("reason").is_none());
    // An error written before the field existed still reads.
    let old: ErrorData =
        serde_json::from_value(json!({"kind":"refused","retryable":false})).unwrap();
    assert_eq!(old.reason, None);
    let future: ErrorData = serde_json::from_value(
        json!({"kind":"refused","retryable":false,"reason":"future_policy"}),
    )
    .unwrap();
    assert_eq!(future.reason, Some(RefusalReason::Other));
    for (reason, wire) in [
        (RefusalReason::ServiceUnknown, "service_unknown"),
        (RefusalReason::ServiceDisabled, "service_disabled"),
        (RefusalReason::ServiceExpired, "service_expired"),
        (RefusalReason::WorkspaceMismatch, "workspace_mismatch"),
        (RefusalReason::NotOwner, "not_owner"),
        (RefusalReason::OutsideScope, "outside_scope"),
        (RefusalReason::ManagementPeer, "management_peer"),
    ] {
        let error = RpcError::refused_because(reason, "refused");
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["data"]["kind"], "refused");
        assert_eq!(value["data"]["reason"], wire);
        assert_eq!(value["data"]["retryable"], false);
        assert_eq!(serde_json::from_value::<RpcError>(value).unwrap(), error);
    }
    let schema = serde_json::to_value(schemars::schema_for!(RefusalReason)).unwrap();
    assert_eq!(schema["x-fallback"], "other");
    let data = serde_json::to_value(schemars::schema_for!(ErrorData)).unwrap();
    assert!(data["properties"].get("reason").is_some());
    assert!(!data["required"]
        .as_array()
        .unwrap()
        .contains(&json!("reason")));
}

#[test]
fn spawn_params_take_no_credential_under_deny_unknown_fields() {
    let session: SpawnReleaseParams = serde_json::from_value(release_params(false)).unwrap();
    assert_eq!(session.caller_name.as_deref(), Some("test-caller"));
    let external: SpawnReleaseParams = serde_json::from_value(release_params(true)).unwrap();
    assert_eq!(external.caller_name, None);
    assert!(serde_json::to_value(&external)
        .unwrap()
        .get("caller_name")
        .is_none());
    let invoke = json!({"caller_name":"test-caller","node_id":"n","node_name":"d","name":"w","harness":"claude","task":"t","directory":"/tmp","idempotency_key":"spawn-test-20261107-0001"});
    serde_json::from_value::<SpawnInvokeParams>(invoke.clone()).unwrap();
    for key in ["caller_secret", "caller_token", "secret"] {
        let mut unknown = invoke.clone();
        unknown[key] = json!("x");
        assert!(serde_json::from_value::<SpawnInvokeParams>(unknown).is_err());
        let mut unknown = release_params(true);
        unknown[key] = json!("x");
        assert!(serde_json::from_value::<SpawnReleaseParams>(unknown).is_err());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_external_caller_is_held_to_its_harnesses_and_folders() {
    let relaycast = Relaycast::new();
    let allowed = tempfile::tempdir().unwrap();
    let inside = allowed.path().join("repo");
    std::fs::create_dir(&inside).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let stub = Stub::new(ExternalCaller {
        harnesses: Some(vec!["codex".into()]),
        directory_roots: Some(vec![allowed.path().into()]),
        ..service(true)
    });
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    let error = bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "claude", inside.to_str().unwrap()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.reason, Some(RefusalReason::OutsideScope));
    assert!(relaycast.untouched());

    let escape = format!("{}/../{}", inside.display(), { outside.path().display() });
    let directories = [
        outside.path().to_str().unwrap().to_string(),
        escape,
        inside.join("missing").to_str().unwrap().to_string(),
    ];
    let served = relaycast.serve_statuses(
        directories
            .iter()
            .map(|_| {
                (
                    "404 Not Found",
                    json!({"ok": false, "error": {"code": "invocation_not_found", "message": "No accepted invocation"}}),
                )
            })
            .collect(),
    );
    for directory in &directories {
        let error = bound(
            &core,
            "spawn.invoke",
            invoke_params(&core, "codex", directory),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.data.reason,
            Some(RefusalReason::OutsideScope),
            "{directory}"
        );
    }
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), directories.len());
    assert!(requests
        .iter()
        .all(|request| request.starts_with("POST /v1/actions/spawn/replay ")));
    assert_eq!(stub.log().last().unwrap(), "record:invoke:refused");
    // In scope, it reaches Relaycast as itself.
    let served = relaycast.serve(vec![strict_pending()]);
    let answer = bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", inside.to_str().unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(answer["id"], "invocation_new");
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert!(requests[0].starts_with("POST /v1/actions/spawn/strict-invoke "));
    assert!(!requests[0].contains("test-workspace-secret"));
    assert!(requests[0].contains("service-agent-token"));
    assert_eq!(stub.log().last().unwrap(), "record:invoke:ok");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_external_caller_refuses_a_server_that_did_not_apply_the_strict_contract() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    let directory = tempfile::tempdir().unwrap();
    let served = relaycast.serve(vec![json!({"id":"invocation_new","status":"pending"})]);
    let error = bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", directory.path().to_str().unwrap()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Internal);
    assert_eq!(served.join().unwrap().len(), 1);
    assert_eq!(stub.log().last().unwrap(), "record:invoke:internal");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_external_caller_requires_the_exact_replay_resume_proofs() {
    for response in [
        json!({
            "id": "invocation_new",
            "status": "pending",
            "spawn_contract_applied": "relay.spawn.invoke.logical/1",
            "spawn_replay_capability_applied": "relay.spawn.replay-resume/1",
        }),
        json!({
            "id": "invocation_new",
            "status": "pending",
            "spawn_contract_applied": "relay.spawn.invoke.logical-replay-resume/1",
        }),
        json!({
            "id": "invocation_new",
            "status": "pending",
            "spawn_contract_applied": "relay.spawn.invoke.logical-replay-resume/1",
            "spawn_replay_capability_applied": "relay.spawn.replay-resume/0",
        }),
    ] {
        let relaycast = Relaycast::new();
        let stub = Stub::new(service(true));
        let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
        let directory = tempfile::tempdir().unwrap();
        let served = relaycast.serve(vec![response]);
        let error = bound(
            &core,
            "spawn.invoke",
            invoke_params(&core, "codex", directory.path().to_str().unwrap()),
        )
        .await
        .unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::Internal);
        let requests = served.join().unwrap();
        assert_eq!(requests.len(), 1, "unexpected fallback: {requests:?}");
        assert!(requests[0].starts_with("POST /v1/actions/spawn/strict-invoke "));
        assert_eq!(stub.log().last().unwrap(), "record:invoke:internal");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_external_caller_never_falls_back_to_the_legacy_route_on_an_old_server() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    let listener = relaycast.listener.try_clone().unwrap();
    let served = std::thread::spawn(move || {
        let mut requests = Vec::new();
        let (mut stream, _) = listener.accept().unwrap();
        requests.push(read_request(&mut stream));
        let body = json!({
            "ok": false,
            "error": {"code": "route_not_found", "message": "No such route"}
        })
        .to_string();
        write!(
            stream,
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();

        // A compatibility fallback would enqueue a second connection on the
        // legacy route. Give it a bounded window so this assertion itself
        // cannot hang when the client correctly fails closed.
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        while std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    requests.push(read_request(&mut stream));
                    let body = json!({
                        "ok": true,
                        "data": {"id": "legacy_side_effect", "status": "pending"}
                    })
                    .to_string();
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        }
        requests
    });
    let directory = tempfile::tempdir().unwrap();
    let error = bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", directory.path().to_str().unwrap()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::NotFound);
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 1, "legacy fallback occurred: {requests:?}");
    assert!(requests[0].starts_with("POST /v1/actions/spawn/strict-invoke "));
    assert_eq!(stub.log().last().unwrap(), "record:invoke:not_found");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_scoped_spawn_forwards_the_checked_path_after_a_symlink_swap() {
    use std::os::unix::fs::symlink;

    let relaycast = Relaycast::new();
    let allowed = tempfile::tempdir().unwrap();
    let checked_target = allowed.path().join("checked-target");
    std::fs::create_dir(&checked_target).unwrap();
    let checked = allowed.path().join("checked");
    symlink(&checked_target, &checked).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let selected = allowed.path().join("selected");
    symlink(&checked, &selected).unwrap();
    let stub = Stub::new(ExternalCaller {
        harnesses: Some(vec!["codex".into()]),
        directory_roots: Some(vec![allowed.path().into()]),
        ..service(true)
    });
    let (_home, core) = core_with(Some(stub), &relaycast.base);
    let listener = relaycast.listener.try_clone().unwrap();
    let moved = selected.clone();
    let escaped = outside.path().to_path_buf();
    let served = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_request(&mut stream);
        std::fs::remove_file(&moved).unwrap();
        symlink(&escaped, &moved).unwrap();
        let body = json!({"ok":true,"data":strict_pending()}).to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
        vec![request]
    });
    bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", selected.to_str().unwrap()),
    )
    .await
    .unwrap();
    let requests = served.join().unwrap();
    let body = request_body(&requests[0]);
    let checked = std::fs::canonicalize(&checked).unwrap();
    assert_eq!(body["input"]["worker_cwd"], checked.to_str().unwrap());
    assert_eq!(
        body["input"]["logical_request"]["directory"],
        selected.to_str().unwrap()
    );
    assert!(!requests[0].contains(outside.path().to_str().unwrap()));
}

#[tokio::test(flavor = "multi_thread")]
async fn admit_failure_prevents_the_relaycast_request() {
    let relaycast = Relaycast::new();
    let stub = Stub::admitting(
        service(true),
        RpcError::new(ErrorKind::RateLimited, "slow down"),
    );
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_service"));
    for (method, params) in [
        ("spawn.status", status_params(true)),
        ("spawn.release", release_params(true)),
    ] {
        let error = bound(&core, method, params).await.unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::RateLimited);
        assert!(relaycast.untouched());
    }
    assert!(stub.log().iter().all(|line| !line.starts_with("record:")));
    assert!(!core
        .config
        .app_data_dir
        .join("spawn-control-releases")
        .exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn record_runs_for_success_and_refusal() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_other"));
    let served = relaycast.serve(vec![json!({"id":"invocation_9","status":"running"})]);
    bound(&core, "spawn.status", status_params(true))
        .await
        .unwrap();
    assert!(served.join().unwrap()[0].contains("service-agent-token"));
    bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap_err();
    // A reply Relaycast sent that this core cannot read is recorded too.
    let served = relaycast.serve(vec![json!({"id":"invocation_other","status":"running"})]);
    let error = bound(&core, "spawn.status", status_params(true))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Internal);
    served.join().unwrap();
    assert_eq!(
        stub.log(),
        [
            "connection:1",
            "admit:status:agent_service:Some(42)",
            "record:status:ok",
            "connection:1",
            "admit:release:agent_service:Some(42)",
            "record:release:refused",
            "connection:1",
            "admit:status:agent_service:Some(42)",
            "record:status:internal",
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_record_withholds_the_receipt_and_a_retry_recovers_it() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_service"));
    let failure = RpcError::new(ErrorKind::Busy, "the receipt ledger is busy");
    stub.fail_record(Some(failure.clone()));
    let served = relaycast.serve(vec![released()]);
    let error = bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap_err();
    // The side effect happened and the plugin saw its receipt, but the
    // caller got the plugin's retryable error instead of the receipt.
    assert_eq!(error, failure);
    assert!(error.data.retryable);
    assert_eq!(served.join().unwrap().len(), 1);
    let recorded = stub.recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].as_ref().unwrap()["released"], true);
    // The release claim stayed, so the same request (same idempotency key)
    // replays the invocation and returns its receipt once recorded.
    let claims = home.path().join("app-data").join("spawn-control-releases");
    assert_eq!(std::fs::read_dir(&claims).unwrap().count(), 1);
    stub.fail_record(None);
    let served = relaycast.serve(vec![released()]);
    let answer = bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap();
    assert_eq!(answer["released"], true);
    let requests = served.join().unwrap();
    assert!(requests[0].contains(IDEMPOTENCY));
    assert_eq!(stub.recorded().last().unwrap().as_ref().unwrap(), &answer);
    // A failing record after a refusal leaves the refusal as it was.
    let (_other_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_other"));
    stub.fail_record(Some(failure));
    let error = bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap_err();
    assert_eq!(error.data.reason, Some(RefusalReason::NotOwner));
    assert!(relaycast.untouched());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_recorded_release_receipt_is_exactly_the_one_returned() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_service"));
    let served = relaycast.serve(vec![json!({
        "invocation_id":"invocation_release",
        "status":"completed",
        "dispatched_node_id":"node_local",
        "output":{"released":true,"name":"test-worker","spawned":false,"ready":false},
        "error":null
    })]);
    let answer = bound(&core, "spawn.release", release_params(true))
        .await
        .unwrap();
    served.join().unwrap();
    assert_eq!(answer["status"], "completed");
    assert_eq!(answer["released"], true);
    let recorded = stub.recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].as_ref().unwrap(), &answer);
    assert_eq!(
        serde_json::to_string(recorded[0].as_ref().unwrap()).unwrap(),
        serde_json::to_string(&answer).unwrap()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_connection_that_turned_external_is_refused_before_its_side_effect() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_other"));
    let workspace = core.workspace().unwrap();
    let params: SpawnInvocationParams = serde_json::from_value(status_params(false)).unwrap();
    for turned in [
        ConnectionCaller::Bound(service(true)),
        ConnectionCaller::Refused(RpcError::refused_because(
            RefusalReason::ServiceUnknown,
            "caller_unbound",
        )),
        ConnectionCaller::Refused(RpcError::new(ErrorKind::Refused, "connection_closed")),
    ] {
        stub.set(2, ConnectionCaller::NotExternal);
        let resolved = resolve(
            &core,
            &CallContext {
                peer_pid: None,
                connection_id: Some(2),
            },
            &status_params(false),
        )
        .unwrap();
        let caller = caller_in(&core, &workspace, resolved, Some("test-caller")).unwrap();
        // The connection challenges (or binds, or closes) meanwhile.
        stub.set(2, turned);
        let call = SpawnCall {
            peer_pid: None,
            connection_id: Some(2),
            workspace: &workspace,
            request: SpawnRequest::Status(&params),
        };
        let error = caller
            .admitted(call, async { panic!("the side effect never runs") })
            .await
            .unwrap_err();
        assert_class(
            &error,
            ErrorKind::Refused,
            "caller_unbound",
            Some(RefusalReason::ServiceUnknown),
        );
    }
    assert!(relaycast.untouched());
}

/// A service-caller spawn whose local receipt write failed retries the exact
/// keyed Relaycast request after a cold restart. External calls do not depend
/// on a fresh target listing: Relaycast's durable claim owns exact-body
/// idempotency and returns the original invocation.
async fn a_retry_after_a_failed_record_replays_the_durable_relaycast_claim() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (home, core) = core_with(Some(stub.clone()), &relaycast.base);
    let directory = tempfile::tempdir().unwrap();
    let directory = directory.path().to_str().unwrap().to_string();
    let node_name = crate::relay::spawn::node_name(&core.machine_prefix);
    let failure = RpcError::new(ErrorKind::StoreFailed, "the receipt ledger is unavailable");
    stub.fail_record(Some(failure.clone()));
    let served = relaycast.serve(vec![strict_pending()]);
    let error = bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", &directory),
    )
    .await
    .unwrap_err();
    assert_eq!(error, failure);
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert!(requests[0].starts_with("POST /v1/actions/spawn/strict-invoke "));
    let first_body = requests[0]
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap();
    let first_json: Value = serde_json::from_str(&first_body).unwrap();
    assert_eq!(
        first_json["input"]["spawn_contract"],
        "relay.spawn.invoke.logical-replay-resume/1"
    );
    assert_eq!(first_json["input"]["target_node_id"], "node_local");
    assert_eq!(
        first_json["input"]["logical_request"],
        json!({
            "schema": "relay.spawn.invoke.logical-replay-resume/1",
            "target_node_id": "node_local",
            "target_node": node_name,
            "name": "test-new-worker",
            "cli": "codex",
            "task": "do the thing",
            "directory": directory,
            "verify_ready": true,
        })
    );
    assert_eq!(first_json["input"]["worker_cwd"], directory);

    // A restart has no local receipt or intent file to consult. The identical
    // POST and key recover from Relaycast's durable claim directly.
    drop(core);
    let stub = Stub::new(service(true));
    let core = core_at(home.path(), Some(stub.clone()), &relaycast.base);
    let served = relaycast.serve(vec![strict_pending()]);
    let answer = bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", &directory),
    )
    .await
    .unwrap();
    let requests = served.join().unwrap();
    assert_eq!(answer["id"], "invocation_new");
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert!(requests[0].starts_with("POST /v1/actions/spawn/strict-invoke "));
    assert!(requests[0].contains("spawn-test-20261107-0001"));
    let replay_body = requests[0]
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap();
    assert_eq!(replay_body, first_body);
    assert_eq!(stub.recorded().last().unwrap().as_ref().unwrap(), &answer);
    assert_eq!(stub.log().last().unwrap(), "record:invoke:ok");
    assert!(!home
        .path()
        .join("app-data")
        .join("spawn-control-receipts")
        .exists());
    assert!(!home
        .path()
        .join("app-data")
        .join("spawn-control-invokes")
        .exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_retry_after_restart_replays_the_exact_request_without_rechecking_the_target() {
    a_retry_after_a_failed_record_replays_the_durable_relaycast_claim().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_retry_rechecks_a_moved_allowed_directory_without_changing_its_logical_claim() {
    use std::os::unix::fs::symlink;

    let relaycast = Relaycast::new();
    let allowed = tempfile::tempdir().unwrap();
    let first_target = allowed.path().join("first-target");
    let second_target = allowed.path().join("second-target");
    std::fs::create_dir(&first_target).unwrap();
    std::fs::create_dir(&second_target).unwrap();
    let selected = allowed.path().join("selected");
    symlink(&first_target, &selected).unwrap();
    let stub = Stub::new(ExternalCaller {
        harnesses: Some(vec!["codex".into()]),
        directory_roots: Some(vec![allowed.path().into()]),
        ..service(true)
    });
    stub.fail_record(Some(RpcError::new(
        ErrorKind::StoreFailed,
        "the receipt ledger is unavailable",
    )));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);

    let served = relaycast.serve(vec![strict_pending()]);
    bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", selected.to_str().unwrap()),
    )
    .await
    .unwrap_err();
    let first_request = served.join().unwrap().pop().unwrap();

    std::fs::remove_file(&selected).unwrap();
    symlink(&second_target, &selected).unwrap();
    stub.fail_record(None);
    let served = relaycast.serve(vec![strict_pending()]);
    bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", selected.to_str().unwrap()),
    )
    .await
    .unwrap();
    let second_request = served.join().unwrap().pop().unwrap();

    let first_body = request_body(&first_request);
    let second_body = request_body(&second_request);
    assert_eq!(
        first_body["input"]["logical_request"],
        second_body["input"]["logical_request"]
    );
    assert_eq!(
        first_body["input"]["logical_request"]["directory"],
        selected.to_str().unwrap()
    );
    assert_eq!(
        first_body["input"]["worker_cwd"],
        std::fs::canonicalize(&first_target)
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(
        second_body["input"]["worker_cwd"],
        std::fs::canonicalize(&second_target)
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_ne!(
        first_body["input"]["worker_cwd"],
        second_body["input"]["worker_cwd"]
    );
    let idempotency = |request: &str| {
        request
            .lines()
            .find(|line| line.to_ascii_lowercase().contains("idempotency"))
            .unwrap()
            .to_string()
    };
    assert_eq!(idempotency(&first_request), idempotency(&second_request));
    assert!(first_request.contains("spawn-test-20261107-0001"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_retry_recovers_an_accepted_claim_without_reusing_an_unsafe_directory() {
    let relaycast = Relaycast::new();
    let allowed = tempfile::tempdir().unwrap();
    let revoked = tempfile::tempdir().unwrap();
    let caller = |root: &std::path::Path| ExternalCaller {
        directory_roots: Some(vec![root.into()]),
        ..service(true)
    };
    let first = Stub::new(caller(allowed.path()));
    first.fail_record(Some(RpcError::new(
        ErrorKind::StoreFailed,
        "the receipt ledger is unavailable",
    )));
    let (home, core) = core_with(Some(first), &relaycast.base);
    let served = relaycast.serve(vec![strict_pending()]);
    bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", allowed.path().to_str().unwrap()),
    )
    .await
    .unwrap_err();
    let first_requests = served.join().unwrap();
    assert_eq!(first_requests.len(), 1);
    let first_request = first_requests.into_iter().next().unwrap();
    drop(core);

    let core = core_at(
        home.path(),
        Some(Stub::new(caller(revoked.path()))),
        &relaycast.base,
    );
    let served = relaycast.serve(vec![strict_pending()]);
    let answer = bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", allowed.path().to_str().unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(answer["id"], "invocation_new");
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /v1/actions/spawn/replay "));
    let body = request_body(&requests[0]);
    let first_body = request_body(&first_request);
    assert_eq!(body.as_object().unwrap().len(), 1);
    assert_eq!(
        body["logical_request"],
        first_body["input"]["logical_request"]
    );
    assert_eq!(
        body["logical_request"]["directory"],
        allowed.path().to_str().unwrap()
    );
    assert_eq!(body["logical_request"]["task"], first_body["input"]["task"]);
    let idempotency = |request: &str| {
        request
            .lines()
            .find(|line| line.to_ascii_lowercase().contains("idempotency"))
            .unwrap()
            .to_string()
    };
    assert_eq!(idempotency(&first_request), idempotency(&requests[0]));
    assert!(body.get("input").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_fails_closed_when_the_server_omits_the_replay_capability_proof() {
    let relaycast = Relaycast::new();
    let allowed = tempfile::tempdir().unwrap();
    let revoked = tempfile::tempdir().unwrap();
    let caller = |root: &std::path::Path| ExternalCaller {
        directory_roots: Some(vec![root.into()]),
        ..service(true)
    };
    let first = Stub::new(caller(allowed.path()));
    first.fail_record(Some(RpcError::new(
        ErrorKind::StoreFailed,
        "the receipt ledger is unavailable",
    )));
    let (home, core) = core_with(Some(first), &relaycast.base);
    let served = relaycast.serve(vec![strict_pending()]);
    bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", allowed.path().to_str().unwrap()),
    )
    .await
    .unwrap_err();
    assert_eq!(served.join().unwrap().len(), 1);
    drop(core);

    let second = Stub::new(caller(revoked.path()));
    let core = core_at(home.path(), Some(second.clone()), &relaycast.base);
    let served = relaycast.serve(vec![json!({
        "id": "invocation_new",
        "status": "pending",
        "spawn_contract_applied": "relay.spawn.invoke.logical-replay-resume/1",
    })]);
    let error = bound(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", allowed.path().to_str().unwrap()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Internal);
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 1, "unexpected fallback: {requests:?}");
    assert!(requests[0].starts_with("POST /v1/actions/spawn/replay "));
    assert_eq!(second.log().last().unwrap(), "record:invoke:internal");
}
