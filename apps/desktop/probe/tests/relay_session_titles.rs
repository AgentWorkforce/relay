//! Native title bridge behavior without touching installed harnesses.
use agent_relay_probe::relay::{
    contract::agents::SessionTitleCapability,
    daemon::{Config, Core, Plugins},
    delivery::DeliveryTiming,
    local_methods,
    paths::CorePaths,
    push::PushTiming,
    sessions::{DiscoveredSession, SessionDirectory},
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Titles(Mutex<Vec<(String, String, String)>>);
impl SessionDirectory for Titles {
    fn sessions(&self) -> Vec<DiscoveredSession> {
        vec![]
    }
    fn title_capability(&self, source: &str, _: &str) -> SessionTitleCapability {
        SessionTitleCapability {
            supported: source == "codex",
            reason: (source != "codex").then(|| "Not available.".into()),
        }
    }
    fn set_title(&self, source: &str, id: &str, title: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .push((source.into(), id.into(), title.into()));
        if source == "codex" {
            Ok(title.to_owned())
        } else {
            Err("Not available.".into())
        }
    }
}
fn core(home: &std::path::Path, titles: Arc<Titles>) -> Arc<Core> {
    let config = Config {
        paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app"),
        env: Default::default(),
        version: "test".into(),
        host_name: "test".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    Core::with_plugins(
        config,
        Plugins {
            sessions: titles,
            ..Plugins::default()
        },
    )
    .0
}
#[tokio::test]
async fn title_bridge_targets_exact_source_and_id_and_returns_native_ack() {
    let home = tempfile::tempdir().unwrap();
    let titles = Arc::new(Titles::default());
    let core = core(home.path(), titles.clone());
    let capability = local_methods::call(
        &core,
        "sessions.title.capability",
        json!({"source":"codex","session_id":"exact-id"}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(capability, json!({"supported":true,"reason":null}));
    let changed = local_methods::call(
        &core,
        "sessions.title.set",
        json!({"source":"codex","session_id":"exact-id","title":"  Fix login  "}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(changed, json!({"title":"Fix login"}));
    assert_eq!(
        *titles.0.lock().unwrap(),
        vec![("codex".into(), "exact-id".into(), "Fix login".into())]
    );
}
#[tokio::test]
async fn malformed_requests_never_reach_provider_and_refusals_are_errors() {
    let home = tempfile::tempdir().unwrap();
    let titles = Arc::new(Titles::default());
    let core = core(home.path(), titles.clone());
    for request in [
        json!({"source":"codex","session_id":"exact-id","title":""}),
        json!({"source":"codex","session_id":"exact-id","title":"A\nB"}),
        json!({"source":"codex","session_id":"exact-id","title":"Fine","path":"/untrusted"}),
        json!({"source":"../codex","session_id":"exact-id","title":"Fine"}),
        Value::Null,
    ] {
        assert!(local_methods::call(&core, "sessions.title.set", request)
            .await
            .unwrap()
            .is_err());
    }
    assert!(titles.0.lock().unwrap().is_empty());
    let result = local_methods::call(
        &core,
        "sessions.title.set",
        json!({"source":"unavailable","session_id":"exact-id","title":"Fine"}),
    )
    .await
    .unwrap();
    assert!(result.is_err());
}
