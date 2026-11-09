//! One external consumer, compiled unchanged against either target library.
use agent_relay_node::relay::{
    client::WorkspaceInfo,
    daemon::{AccountPlugin, Config, Core, Plugins},
    delivery::DeliveryTiming,
    outbound::{Outbound, OutboundError, Request},
    paths::CorePaths,
    peer::current_uid,
    push::PushTiming,
    usage::UsageEvent,
    workspace::Workspace,
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

struct FakeAccount {
    manages: bool,
    calls: Arc<Mutex<Vec<(i32, u32)>>>,
}
struct NoDirect;
impl agent_relay_node::relay::setup::DirectDelivery for NoDirect {
    fn delivers_directly(&self) -> bool {
        false
    }
    fn managed_value(&self) -> Option<String> {
        None
    }
    fn user_choice(&self) -> Option<String> {
        None
    }
    fn set_direct_delivery(&self, _: bool) -> Result<(), String> {
        panic!("proof forbids settings changes")
    }
}
impl AccountPlugin for FakeAccount {
    fn attach(&self, _: &Arc<Core>) {}
    fn run(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn report(&self) -> Value {
        Value::Null
    }
    fn maintain(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn recover_workspace_key<'a>(
        &'a self,
        _: &'a Workspace,
        _: &'a str,
    ) -> BoxFuture<'a, Option<(Workspace, WorkspaceInfo)>> {
        Box::pin(async { None })
    }
    fn agents_changed(&self, _: &Arc<Core>) {}
    fn mcp_linked_at(&self, _: &str) -> Option<String> {
        None
    }
    fn cloud_identity_sync(&self, _: &Core) -> Value {
        Value::Null
    }
    fn refresh_tools(&self, _: &Core) -> Vec<String> {
        Vec::new()
    }
    fn site_url(&self) -> String {
        "https://fixture.invalid".into()
    }
    fn record_usage(&self, _: UsageEvent) {}
    fn person_changed_settings(&self, _: &serde_json::Map<String, Value>) {}
    fn as_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
    fn session_route<'a>(
        &'a self,
        _: &'a Outbound,
        pid: i32,
        uid: u32,
        request: &'a Request,
    ) -> Option<BoxFuture<'a, Result<Value, OutboundError>>> {
        if request.method != "POST" || request.path != "/copilot/mcp" {
            return None;
        }
        self.calls.lock().unwrap().push((pid, uid));
        if !self.manages {
            return None;
        }
        Some(Box::pin(async move {
            // Fake account policy verifies that the outer router preserved both peer fields.
            if pid != 1234 || uid != current_uid() {
                return Err(OutboundError::new(
                    403,
                    "fixture_peer_refused",
                    "Fixture policy refused peer.",
                ));
            }
            let body: Value = serde_json::from_slice(&request.body).expect("fixed fixture JSON");
            Ok(
                json!({"jsonrpc":"2.0","id":body["request"]["id"],"result":{"protocolVersion":"2025-03-26"}}),
            )
        }))
    }
}

/// Build an inert core with explicit private storage and no inherited provider configuration.
fn outbound(home: &Path, account: Option<Arc<dyn AccountPlugin>>) -> Outbound {
    std::fs::create_dir_all(home).unwrap();
    let config = Config {
        paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app-data"),
        env: BTreeMap::new(),
        version: "route-proof".into(),
        host_name: "Route Proof".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    let core = Core::with_plugins(
        config,
        Plugins {
            account,
            ..Plugins::default()
        },
    )
    .0;
    Outbound::new(core, Arc::new(NoDirect))
}

/// Construct the exact native initialize envelope or a deliberately invalid fallback body.
fn request(method: &str, path: &str, malformed: bool) -> Request {
    Request {
        method: method.into(),
        path: path.into(),
        query: Default::default(),
        headers: Default::default(),
        body: if malformed {
            b"not JSON and not a Codex hook".to_vec()
        } else {
            serde_json::to_vec(&json!({"binding":{},"request":{"jsonrpc":"2.0","id":"native-init","method":"initialize"}})).unwrap()
        },
    }
}

/// Reduce production responses to an explicit, body-free observation vocabulary.
fn observation(reply: Result<Value, OutboundError>) -> Value {
    match reply {
        Ok(value) => {
            json!({"status":200,"id":value["id"],"protocol":value["result"]["protocolVersion"]})
        }
        Err(error) => json!({"status":error.status,"code":error.code}),
    }
}

/// Exercise the same real outer router for every arm; no expected result is selected here.
#[tokio::main]
async fn main() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let managed = outbound(
        &root.path().join("managed"),
        Some(Arc::new(FakeAccount {
            manages: true,
            calls: calls.clone(),
        })),
    );
    let init = observation(
        managed
            .handle(1234, current_uid(), &request("POST", "/copilot/mcp", false))
            .await,
    );
    let wrong_pid = observation(
        managed
            .handle(1235, current_uid(), &request("POST", "/copilot/mcp", false))
            .await,
    );
    let wrong_uid = observation(
        managed
            .handle(
                1234,
                current_uid().wrapping_add(1),
                &request("POST", "/copilot/mcp", false),
            )
            .await,
    );
    let get = observation(
        managed
            .handle(1234, current_uid(), &request("GET", "/copilot/mcp", false))
            .await,
    );
    let recorded = calls.lock().unwrap().clone();
    let peer_forwarding = recorded
        == [
            (1234, current_uid()),
            (1235, current_uid()),
            (1234, current_uid().wrapping_add(1)),
        ];
    let bare = outbound(&root.path().join("bare"), None);
    let no_account = observation(
        bare.handle(1234, current_uid(), &request("POST", "/copilot/mcp", true))
            .await,
    );
    let control = observation(
        bare.handle(
            1234,
            current_uid(),
            &request("POST", "/claude/attestation", true),
        )
        .await,
    );
    let declined_calls = Arc::new(Mutex::new(Vec::new()));
    let declined = outbound(
        &root.path().join("declined"),
        Some(Arc::new(FakeAccount {
            manages: false,
            calls: declined_calls.clone(),
        })),
    );
    let declined_reply = observation(
        declined
            .handle(1234, current_uid(), &request("POST", "/copilot/mcp", true))
            .await,
    );
    let declined_count = declined_calls.lock().unwrap().len();
    println!(
        "{}",
        json!({"managed":init,"wrongPid":wrong_pid,"wrongUid":wrong_uid,"get":get,"noAccount":no_account,"declined":declined_reply,"control":control,"managedCalls":recorded.len(),"declinedCalls":declined_count,"peerForwarding":peer_forwarding})
    );
}
