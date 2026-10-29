//! The registry and the server agree: every registered method reaches a
//! handler, and the daemon's `hello` lists exactly the registry. Parameters
//! that are not an object are refused before any handler runs, so each
//! method is reached without doing anything.

use agent_relay_probe::relay::account::Account;
use agent_relay_probe::relay::cloud_session::CloudAccess;
use agent_relay_probe::relay::contract::{self, METHODS};
use agent_relay_probe::relay::daemon::{self, BoundSocket, Config, Core, Plugins};
use agent_relay_probe::relay::delivery::DeliveryTiming;
use agent_relay_probe::relay::paths::{self, CorePaths};
use agent_relay_probe::relay::protocol::BRIDGE_VERSION;
use agent_relay_probe::relay::push::PushTiming;
use agent_relay_probe::relay::transport::CoreStream;
use agent_relay_probe::relay::uploader::{InstallRun, ProbeRunner, Uploader, UploaderError};
use agent_relay_probe::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// An uploader whose every command fails: nothing here runs the probe.
struct NoProbe;

impl ProbeRunner for NoProbe {
    fn run(
        &self,
        _: Vec<String>,
        _: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        Box::pin(async { Err(UploaderError::new("No probe in this test.")) })
    }

    fn install(&self, _: Vec<String>, _: Option<Secret>) -> Result<InstallRun, UploaderError> {
        Err(UploaderError::new("No probe in this test."))
    }

    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn every_registered_method_reaches_a_handler() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().to_path_buf();
    let socket = home.join("run/core.sock");
    let mut env = BTreeMap::new();
    env.insert(
        "RELAYCAST_URL".to_string(),
        "http://127.0.0.1:9".to_string(),
    );
    let app_data_dir = home.join("app-data");
    let config = Config {
        paths: CorePaths::for_socket(socket.clone()).unwrap(),
        home: home.clone(),
        app_data_dir: app_data_dir.clone(),
        env: env.clone(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    paths::socket_directory(config.paths.directory()).unwrap();
    let bound = BoundSocket::bind(&config.paths).unwrap();
    let account = Arc::new(Account::new(
        Some("https://agentrelay.com"),
        &home,
        &env,
        &app_data_dir,
        Arc::new(Uploader::new(Arc::new(NoProbe))),
    ));
    let plugins = Plugins {
        cloud: account.clone() as Arc<dyn CloudAccess>,
        account: Some(account),
        ..Plugins::default()
    };
    let (core, signals): (Arc<Core>, _) = Core::with_plugins(config, plugins);
    let task = tokio::spawn(daemon::run(core.clone(), bound, signals));

    let stream = CoreStream::connect(&socket).await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let mut id = 0;
    let mut call = |method: &str, params: Value| {
        id += 1;
        (
            id,
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
                + "\n",
        )
    };
    let mut answer = async |request: (i32, String)| -> Value {
        write.write_all(request.1.as_bytes()).await.unwrap();
        loop {
            let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
                .await
                .expect("the daemon answers")
                .unwrap()
                .expect("a response before close");
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["id"] == json!(request.0) {
                return value;
            }
        }
    };

    let refused = answer(call("hello", json!("not an object"))).await;
    assert_eq!(refused["error"]["data"]["kind"], "invalid_params");
    let hello = answer(call("hello", json!({"bridge_version": BRIDGE_VERSION}))).await;
    let status = answer(call("status.get", json!({}))).await;
    assert_eq!(
        status["result"]["daemon"]["history_version"],
        json!(agent_relay_probe::history_version())
    );
    assert_eq!(
        status["result"]["daemon"]["build_revision"],
        agent_relay_probe::BUILD_REVISION
    );
    let listed: Vec<String> = serde_json::from_value(hello["result"]["methods"].clone()).unwrap();
    let registered: Vec<String> = METHODS.iter().map(|m| m.name.to_string()).collect();
    assert_eq!(listed, registered, "hello lists the registry");
    assert_eq!(
        hello["result"]["topics"],
        serde_json::to_value(contract::topics()).unwrap()
    );

    for spec in METHODS {
        let response = answer(call(spec.name, json!("not an object"))).await;
        assert_eq!(
            response["error"]["data"]["kind"], "invalid_params",
            "{}: {response}",
            spec.name
        );
    }
    let unknown = answer(call("no.such.method", json!({}))).await;
    assert_eq!(unknown["error"]["data"]["kind"], "method_not_found");

    core.request_shutdown();
    let _ = task.await;
}
