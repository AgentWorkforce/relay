//! Exercise the public router, rather than calling the account handler directly.
use agent_relay_node::relay::{
    client::WorkspaceInfo,
    daemon::{AccountPlugin, Config, Core, Plugins},
    delivery::DeliveryTiming,
    outbound::{Outbound, OutboundError, Request},
    paths::CorePaths,
    peer::current_uid,
    push::PushTiming,
    test_account::TestAccount,
    usage::UsageEvent,
    workspace::Workspace,
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

/// A stand-in for Desktop's account-owned transport and peer refusal.
struct ManagedAccount;
/// Refuse any unexpected settings write during a routing-only test.
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
        panic!("no settings writes")
    }
}

impl AccountPlugin for ManagedAccount {
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
        "https://relay.test".into()
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
        Some(Box::pin(async move {
            // The account, not the generic router, verifies the native peer.
            if pid != 1234 || uid != current_uid() {
                return Err(OutboundError::new(403, "fixture_peer_refused", "Refused."));
            }
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            Ok(json!({"jsonrpc":"2.0", "id":body["request"]["id"],
                "result":{"protocolVersion":"2025-03-26"}}))
        }))
    }
}

/// Construct the production core in an isolated directory without running discovery.
fn core(home: &std::path::Path, account: Option<Arc<dyn AccountPlugin>>) -> Arc<Core> {
    let config = Config {
        paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app-data"),
        env: BTreeMap::new(),
        version: "test".into(),
        host_name: "Test Desk".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    Core::with_plugins(
        config,
        Plugins {
            account,
            ..Plugins::default()
        },
    )
    .0
}

/// The same initialize envelope sent by the app-owned stdio bridge.
fn request(method: &str) -> Request {
    Request {
        method: method.into(),
        path: "/copilot/mcp".into(),
        query: Default::default(),
        headers: Default::default(),
        body: serde_json::to_vec(&json!({"binding":{}, "request":{
            "jsonrpc":"2.0", "id":"native-init", "method":"initialize"
        }}))
        .unwrap(),
    }
}

#[tokio::test]
/// The outer router must preserve the request and caller for account verification.
async fn native_mcp_initialization_reaches_the_account_through_the_outer_router() {
    let temp = tempfile::tempdir().unwrap();
    let outbound = Outbound::new(
        core(temp.path(), Some(Arc::new(ManagedAccount))),
        Arc::new(NoDirect),
    );
    let reply = outbound
        .handle(1234, current_uid(), &request("POST"))
        .await
        .unwrap();
    assert_eq!(reply["id"], "native-init");
    assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
    for (pid, uid) in [(1235, current_uid()), (1234, current_uid().wrapping_add(1))] {
        let error = outbound
            .handle(pid, uid, &request("POST"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "fixture_peer_refused");
    }
    assert_eq!(
        outbound
            .handle(1234, current_uid(), &request("GET"))
            .await
            .unwrap_err()
            .status,
        404
    );
}

#[tokio::test]
/// A missing account transport refuses before parsing unrelated Codex-hook input.
async fn unmanaged_or_declined_native_mcp_never_falls_into_the_codex_hook() {
    for account in [None, Some(TestAccount::new().into_plugin())] {
        let temp = tempfile::tempdir().unwrap();
        let outbound = Outbound::new(core(temp.path(), account), Arc::new(NoDirect));
        let mut request = request("POST");
        request.body = b"not JSON and not a Codex hook".to_vec();
        let error = outbound
            .handle(1234, current_uid(), &request)
            .await
            .unwrap_err();
        assert_eq!(error.status, 409);
        assert_eq!(error.code, "copilot_dispatch_unavailable");
    }
}
