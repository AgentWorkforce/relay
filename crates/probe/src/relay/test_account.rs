//! A stand-in account for tests of the core, and of builds on it, that need
//! an uploader or usage reports but no sign-in.

use crate::relay::client::WorkspaceInfo;
use crate::relay::daemon::{AccountPlugin, Core};
use crate::relay::outbound::{Outbound, OutboundError, Request};
use crate::relay::protocol::RpcError;
use crate::relay::telemetry::{Telemetry, TelemetryEvent};
use crate::relay::uploader::Uploader;
use crate::relay::workspace::Workspace;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

pub struct TestAccount {
    pub uploader: Arc<Uploader>,
    pub telemetry: Option<Arc<Telemetry>>,
    /// Whether an install was looked for, as a signed-in account does.
    pub looked: bool,
    /// The account's automatic-activation default
    /// ([`AccountPlugin::auto_activate_by_default`]).
    pub auto_activate_by_default: bool,
}

impl TestAccount {
    pub fn new(uploader: Arc<Uploader>) -> TestAccount {
        TestAccount {
            uploader,
            telemetry: None,
            looked: false,
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

    fn call<'a>(
        &'a self,
        _core: &'a Arc<Core>,
        _method: &'a str,
        _raw: Value,
    ) -> BoxFuture<'a, Option<Result<Value, RpcError>>> {
        Box::pin(async { None })
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

    fn uploader(&self) -> Arc<Uploader> {
        self.uploader.clone()
    }

    fn note_identity_sync(&self, _core: &Core, _succeeded: Option<bool>) {}

    fn cloud_identity_sync(&self, _core: &Core) -> Value {
        Value::Null
    }

    fn refresh_tools(&self, _core: &Core) -> Vec<String> {
        Vec::new()
    }

    fn native_capability_changed(&self, _core: &Arc<Core>) {}

    fn attestation_key(&self, _core: &Core) -> Option<Value> {
        None
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
        crate::relay::links::DEFAULT_SITE_URL.into()
    }

    fn record_usage(&self, event: TelemetryEvent) {
        if let Some(telemetry) = &self.telemetry {
            telemetry.record(event);
        }
    }

    fn shared_uploads(&self) -> BTreeSet<String> {
        BTreeSet::new()
    }

    fn looked_for_install(&self) -> bool {
        self.looked
    }

    fn auto_activate_by_default(&self) -> bool {
        self.auto_activate_by_default
    }

    fn as_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}
