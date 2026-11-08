//! Spawn controls called by external callers through the `SpawnCallers`
//! plugin, and the session path with and without it.
use super::*;
use crate::relay::daemon::{Config, Permit, Plugins};
use crate::relay::delivery::DeliveryTiming;
use crate::relay::paths::CorePaths;
use crate::relay::push::PushTiming;
use crate::relay::server;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;

const SECRET: &str = "stub-caller-secret";
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
        let listener = self.listener.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut requests = Vec::new();
            for body in bodies {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_request(&mut stream));
                let body = json!({"ok": true, "data": body}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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

/// A plugin that vouches for one caller and logs what it is asked.
struct Stub {
    caller: Result<ExternalCaller, RpcError>,
    admit: Option<RpcError>,
    log: Mutex<Vec<String>>,
}

impl Stub {
    fn new(caller: ExternalCaller) -> Arc<Stub> {
        Arc::new(Stub {
            caller: Ok(caller),
            admit: None,
            log: Mutex::new(Vec::new()),
        })
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

impl SpawnCallers for Stub {
    fn resolve(
        &self,
        _workspace: &Workspace,
        name: &str,
        secret: &Secret,
    ) -> Result<ExternalCaller, RpcError> {
        self.log.lock().unwrap().push(format!("resolve:{name}"));
        if secret.expose() != SECRET {
            return Err(RpcError::refused_because(
                RefusalReason::ServiceUnknown,
                "unknown",
            ));
        }
        self.caller.clone()
    }

    fn admit(&self, caller: &ExternalCaller, call: &SpawnCall<'_>) -> Result<Permit, RpcError> {
        let (method, secret) = match call.request {
            SpawnRequest::Invoke(p) => ("invoke", p.caller_secret.is_some()),
            SpawnRequest::Status(p) => ("status", p.caller_secret.is_some()),
            SpawnRequest::Release(p) => ("release", p.caller_secret.is_some()),
        };
        assert!(!secret, "the secret never reaches admission");
        self.log.lock().unwrap().push(format!(
            "admit:{method}:{}:{:?}",
            caller.agent_id, call.peer_pid
        ));
        match &self.admit {
            Some(error) => Err(error.clone()),
            None => Ok(Permit::new(method.to_string())),
        }
    }

    fn record(&self, permit: Permit, outcome: &Result<SpawnControlInvocation, RpcError>) {
        let method = permit.downcast::<String>().unwrap();
        let outcome = match outcome {
            Ok(_) => "ok".to_string(),
            Err(error) => serde_json::to_value(error.data.kind).unwrap().to_string(),
        };
        self.log
            .lock()
            .unwrap()
            .push(format!("record:{method}:{}", outcome.trim_matches('"')));
    }
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
    let home = temp.path();
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
    (temp, core)
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

fn release_params(secret: Option<&str>) -> Value {
    let mut params = json!({"caller_name":"test-caller","node_id":"node_local","node_name":"test-desktop","name":"test-worker","expected_agent_id":"agent_worker","idempotency_key": IDEMPOTENCY});
    if let Some(secret) = secret {
        params["caller_name"] = json!("flows-test");
        params["caller_secret"] = json!(secret);
    }
    params
}

fn status_params(secret: Option<&str>) -> Value {
    let mut params =
        json!({"caller_name":"test-caller","action":"release","invocation_id":"invocation_9"});
    if let Some(secret) = secret {
        params["caller_name"] = json!("flows-test");
        params["caller_secret"] = json!(secret);
    }
    params
}

fn invoke_params(core: &Core, harness: &str, directory: &str) -> Value {
    json!({"caller_name":"flows-test","caller_secret": SECRET,"node_id":"node_local","node_name": crate::relay::spawn::node_name(&core.machine_prefix),"name":"test-new-worker","harness": harness,"task":"do the thing","directory": directory,"idempotency_key":"spawn-test-20261107-0001"})
}

fn released() -> Value {
    json!({
        "id":"invocation_release",
        "status":"completed",
        "output":{"released":true,"name":"test-worker"}
    })
}

fn reason(error: &RpcError) -> Option<RefusalReason> {
    error.data.reason
}

#[tokio::test(flavor = "multi_thread")]
async fn a_core_without_spawn_callers_refuses_any_caller_secret() {
    let relaycast = Relaycast::new();
    let (_home, core) = core_with(None, &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_caller"));
    let directory = std::env::temp_dir();
    let mut invoke = invoke_params(&core, "claude", directory.to_str().unwrap());
    // Even a session caller's own name, with a secret, is not a session call.
    invoke["caller_name"] = json!("test-caller");
    let mut status = status_params(Some(SECRET));
    status["caller_name"] = json!("test-caller");
    for (method, params) in [
        ("spawn.invoke", invoke),
        ("spawn.status", status),
        ("spawn.release", release_params(Some(SECRET))),
    ] {
        let error = server::call(&core, method, params).await.unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::Refused, "{method}");
        assert_eq!(reason(&error), None, "{method}");
        assert!(relaycast.untouched(), "{method}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_or_whitespace_external_caller_secret_is_refused_before_plugin_resolution() {
    let relaycast = Relaycast::new();
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_caller"));
    for secret in ["", " \t\r\n"] {
        let mut invoke = invoke_params(&core, "claude", std::env::temp_dir().to_str().unwrap());
        invoke["caller_secret"] = json!(secret);

        let error = server::call(&core, "spawn.invoke", invoke)
            .await
            .unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::Refused, "{secret:?}");
        assert!(stub.log().is_empty(), "{secret:?}");
        assert!(relaycast.untouched(), "{secret:?}");
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
    let session = |name: &str| caller_in(&core, &workspace, name, None);
    assert!(matches!(
        session("test-caller").unwrap(),
        Caller::Session { ref agent_id, ref token }
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
        assert!(caller_in(&core, &wrong, "test-caller", None).is_err());
    }
    // Status and release by the session caller take today's path: its own
    // token, no plugin call, and no owner check on a worker another
    // requester started.
    let served = relaycast.serve(vec![
        json!({"id":"invocation_9","status":"completed"}),
        released(),
    ]);
    server::call(&core, "spawn.status", status_params(None))
        .await
        .unwrap();
    server::call(&core, "spawn.release", release_params(None))
        .await
        .unwrap();
    let requests = served.join().unwrap();
    assert!(requests[0].starts_with("GET /v1/actions/release/invocations/invocation_9 "));
    assert!(requests[1].starts_with("POST /v1/agents/release-exact "));
    for request in &requests {
        assert!(request.contains("test-agent-secret"));
    }
    assert!(stub.log().is_empty(), "{:?}", stub.log());
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
    let context = CallContext {
        peer_pid: Some(42),
        connection_id: Some(1),
    };
    let answer = server::call_from(
        &core,
        &context,
        "spawn.release",
        release_params(Some(SECRET)),
    )
    .await
    .unwrap();
    assert_eq!(answer["id"], "invocation_release");
    assert_eq!(answer["released"], true);
    let requests = served.join().unwrap();
    assert!(requests[0].contains("service-agent-token"));
    assert!(!requests[0].contains("test-agent-secret"));
    assert!(!requests[0].contains(SECRET));
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
            "resolve:flows-test",
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
    let params: SpawnReleaseParams = serde_json::from_value(release_params(None)).unwrap();
    claims::release(
        &core.config.app_data_dir,
        &workspace,
        "agent_service",
        &params,
        true,
        claims::Ownership::Unrestricted,
    )
    .unwrap();
    let error = server::call(&core, "spawn.release", release_params(Some(SECRET)))
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
    let params: SpawnReleaseParams = serde_json::from_value(release_params(None)).unwrap();
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
    let params: SpawnReleaseParams = serde_json::from_value(release_params(None)).unwrap();
    assert!(core
        .store
        .read(|store| release_target(store, &workspace, &params)));
    let error = server::call(&core, "spawn.release", release_params(Some(SECRET)))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Refused);
    assert_eq!(reason(&error), Some(RefusalReason::NotOwner));
    assert!(!error.data.retryable);
    assert!(relaycast.untouched());
    assert_eq!(
        stub.log(),
        [
            "resolve:flows-test",
            "admit:release:agent_service:None",
            "record:release:refused"
        ]
    );
    // A worker with no recorded requester is not the caller's either.
    let (_none_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, None);
    let served = relaycast.serve(vec![
        json!({"caller_name":"someone","caller_id":"agent_other"}),
    ]);
    let error = server::call(&core, "spawn.release", release_params(Some(SECRET)))
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
    server::call(&plain, "spawn.release", release_params(None))
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
    server::call(&core, "spawn.release", release_params(Some(SECRET)))
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
        caller_name: "flows-test".into(),
        caller_secret: None,
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
    server::call(&core, "spawn.release", release_params(Some(SECRET)))
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
fn caller_secret_is_optional_under_deny_unknown_fields() {
    let session: SpawnReleaseParams = serde_json::from_value(release_params(None)).unwrap();
    assert_eq!(session.caller_secret, None);
    assert!(serde_json::to_value(&session)
        .unwrap()
        .get("caller_secret")
        .is_none());
    let external: SpawnReleaseParams =
        serde_json::from_value(release_params(Some(SECRET))).unwrap();
    assert_eq!(external.caller_secret.as_deref(), Some(SECRET));
    let status: SpawnInvocationParams =
        serde_json::from_value(status_params(Some(SECRET))).unwrap();
    assert_eq!(status.caller_secret.as_deref(), Some(SECRET));
    let invoke = json!({"caller_name":"test-caller","node_id":"n","node_name":"d","name":"w","harness":"claude","task":"t","directory":"/tmp","idempotency_key":"spawn-test-20261107-0001"});
    let parsed: SpawnInvokeParams = serde_json::from_value(invoke.clone()).unwrap();
    assert_eq!(parsed.caller_secret, None);
    let mut unknown = invoke;
    unknown["caller_token"] = json!("x");
    assert!(serde_json::from_value::<SpawnInvokeParams>(unknown).is_err());
    let mut unknown = release_params(Some(SECRET));
    unknown["secret"] = json!("x");
    assert!(serde_json::from_value::<SpawnReleaseParams>(unknown).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn service_refusals_keep_their_reason_and_send_nothing() {
    let relaycast = Relaycast::new();
    for reason in [
        RefusalReason::ServiceUnknown,
        RefusalReason::ServiceDisabled,
        RefusalReason::ServiceExpired,
        RefusalReason::WorkspaceMismatch,
    ] {
        let stub = Arc::new(Stub {
            caller: Err(RpcError::refused_because(reason, "refused")),
            admit: None,
            log: Mutex::new(Vec::new()),
        });
        let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
        seed(&core, &relaycast.base, Some("agent_service"));
        let error = server::call(&core, "spawn.release", release_params(Some(SECRET)))
            .await
            .unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::Refused);
        assert_eq!(error.data.reason, Some(reason));
        assert!(relaycast.untouched());
        assert_eq!(stub.log(), ["resolve:flows-test"]);
    }
    // A wrong secret is the plugin's to refuse, like an unknown name.
    let stub = Stub::new(service(true));
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    let error = server::call(&core, "spawn.status", status_params(Some("wrong-secret")))
        .await
        .unwrap_err();
    assert_eq!(error.data.reason, Some(RefusalReason::ServiceUnknown));
    assert!(relaycast.untouched());
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
    let escape = format!("{}/../{}", inside.display(), { outside.path().display() });
    for (harness, directory) in [
        ("claude", inside.to_str().unwrap().to_string()),
        ("codex", outside.path().to_str().unwrap().to_string()),
        ("codex", escape),
        (
            "codex",
            inside.join("missing").to_str().unwrap().to_string(),
        ),
    ] {
        let error = server::call(
            &core,
            "spawn.invoke",
            invoke_params(&core, harness, &directory),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.data.reason,
            Some(RefusalReason::OutsideScope),
            "{harness} {directory}"
        );
        assert!(relaycast.untouched());
    }
    assert_eq!(stub.log().last().unwrap(), "record:invoke:refused");
    // In scope, it reaches Relaycast as itself.
    let node = crate::relay::spawn::node_name(&core.machine_prefix);
    let served = relaycast.serve(vec![
        json!([{"id":"node_local","name": node,"live":true,"handlers_live":true,"active_agents":0,"reserved_agents":0,"max_agents":4,"capabilities":["spawn:codex"]}]),
        json!({"id":"invocation_new","status":"pending"}),
    ]);
    let answer = server::call(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", inside.to_str().unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(answer["id"], "invocation_new");
    let requests = served.join().unwrap();
    assert!(requests[0].contains("test-workspace-secret"));
    assert!(requests[1].starts_with("POST /v1/actions/spawn/invoke "));
    assert!(requests[1].contains("service-agent-token"));
    assert!(!requests[1].contains(SECRET));
    assert_eq!(stub.log().last().unwrap(), "record:invoke:ok");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_scoped_spawn_forwards_the_checked_path_after_a_symlink_swap() {
    use std::os::unix::fs::symlink;

    let relaycast = Relaycast::new();
    let allowed = tempfile::tempdir().unwrap();
    let checked = allowed.path().join("checked");
    std::fs::create_dir(&checked).unwrap();
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
    let node = crate::relay::spawn::node_name(&core.machine_prefix);
    let moved = selected.clone();
    let escaped = outside.path().to_path_buf();
    let served = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for body in [
            json!([{"id":"node_local","name":node,"live":true,"handlers_live":true,"active_agents":0,"reserved_agents":0,"max_agents":4,"capabilities":["spawn:codex"]}]),
            json!({"id":"invocation_new","status":"pending"}),
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            requests.push(read_request(&mut stream));
            if requests.len() == 1 {
                std::fs::remove_file(&moved).unwrap();
                symlink(&escaped, &moved).unwrap();
            }
            let body = json!({"ok":true,"data":body}).to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
        requests
    });
    server::call(
        &core,
        "spawn.invoke",
        invoke_params(&core, "codex", selected.to_str().unwrap()),
    )
    .await
    .unwrap();
    let requests = served.join().unwrap();
    assert!(requests[1].contains(checked.to_str().unwrap()));
    assert!(!requests[1].contains(selected.to_str().unwrap()));
    assert!(!requests[1].contains(outside.path().to_str().unwrap()));
}

#[tokio::test(flavor = "multi_thread")]
async fn admit_failure_prevents_the_relaycast_request() {
    let relaycast = Relaycast::new();
    let stub = Arc::new(Stub {
        caller: Ok(service(true)),
        admit: Some(RpcError::new(ErrorKind::RateLimited, "slow down")),
        log: Mutex::new(Vec::new()),
    });
    let (_home, core) = core_with(Some(stub.clone()), &relaycast.base);
    seed(&core, &relaycast.base, Some("agent_service"));
    for (method, params) in [
        ("spawn.status", status_params(Some(SECRET))),
        ("spawn.release", release_params(Some(SECRET))),
    ] {
        let error = server::call(&core, method, params).await.unwrap_err();
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
    let context = CallContext {
        peer_pid: Some(7),
        connection_id: Some(1),
    };
    server::call_from(&core, &context, "spawn.status", status_params(Some(SECRET)))
        .await
        .unwrap();
    assert!(served.join().unwrap()[0].contains("service-agent-token"));
    server::call(&core, "spawn.release", release_params(Some(SECRET)))
        .await
        .unwrap_err();
    // A reply Relaycast sent that this core cannot read is recorded too.
    let served = relaycast.serve(vec![json!({"id":"invocation_other","status":"running"})]);
    let error = server::call(&core, "spawn.status", status_params(Some(SECRET)))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Internal);
    served.join().unwrap();
    assert_eq!(
        stub.log(),
        [
            "resolve:flows-test",
            "admit:status:agent_service:Some(7)",
            "record:status:ok",
            "resolve:flows-test",
            "admit:release:agent_service:None",
            "record:release:refused",
            "resolve:flows-test",
            "admit:status:agent_service:None",
            "record:status:internal",
        ]
    );
}
