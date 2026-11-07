//! A stand-in account for tests of the core, and of builds on it, that need
//! usage reports but no sign-in.

use crate::relay::client::WorkspaceInfo;
use crate::relay::daemon::{AccountPlugin, Core};
use crate::relay::outbound::{Outbound, OutboundError, Request};
use crate::relay::usage::UsageEvent;
use crate::relay::workspace::Workspace;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct TestAccount {
    /// Every usage report, in order.
    pub usage: Arc<std::sync::Mutex<Vec<UsageEvent>>>,
    /// The account's automatic-activation default
    /// ([`AccountPlugin::auto_activate_by_default`]).
    pub auto_activate_by_default: bool,
}

impl TestAccount {
    pub fn new() -> TestAccount {
        TestAccount {
            usage: Default::default(),
            auto_activate_by_default: false,
        }
    }

    pub fn into_plugin(self) -> Arc<dyn AccountPlugin> {
        Arc::new(self)
    }
}

impl AccountPlugin for TestAccount {
    fn attach(&self, _core: &Arc<Core>) {}

    fn run(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }

    fn report(&self) -> Value {
        json!({"state": "signed_out"})
    }

    fn maintain(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }

    fn recover_workspace_key<'a>(
        &'a self,
        _refused: &'a Workspace,
        _workspace_id: &'a str,
    ) -> BoxFuture<'a, Option<(Workspace, WorkspaceInfo)>> {
        Box::pin(async { None })
    }

    fn agents_changed(&self, _core: &Arc<Core>) {}

    fn mcp_linked_at(&self, _agent_id: &str) -> Option<String> {
        None
    }

    fn cloud_identity_sync(&self, _core: &Core) -> Value {
        Value::Null
    }

    fn refresh_tools(&self, _core: &Core) -> Vec<String> {
        Vec::new()
    }

    fn session_route<'a>(
        &'a self,
        _outbound: &'a Outbound,
        _pid: i32,
        _uid: u32,
        _request: &'a Request,
    ) -> Option<BoxFuture<'a, Result<Value, OutboundError>>> {
        None
    }

    fn site_url(&self) -> String {
        crate::relay::links::built_in_site_url().into()
    }

    fn person_changed_settings(&self, _changes: &serde_json::Map<String, Value>) {}

    fn record_usage(&self, event: UsageEvent) {
        self.usage.lock().unwrap().push(event);
    }

    fn auto_activate_by_default(&self) -> bool {
        self.auto_activate_by_default
    }

    fn as_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}
