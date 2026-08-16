#![cfg(unix)]

use std::{
    fs,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use httpmock::{Method::POST, MockServer};
use nix::{
    sys::signal::{kill, Signal},
    unistd::Pid,
};
use serde_json::json;
use tempfile::TempDir;
use tokio::time::{sleep, timeout};

struct ChildGuard {
    child: Child,
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

async fn wait_for_ready_api(
    child: &mut Child,
    runtime_dir: &TempDir,
    client: &reqwest::Client,
) -> String {
    let connection_path = runtime_dir
        .path()
        .join(".agentworkforce/relay/connection.json");
    timeout(Duration::from_secs(10), async {
        loop {
            if let Some(status) = child.try_wait().expect("read broker status") {
                panic!("broker exited before its API became ready: {status}");
            }
            if let Ok(raw) = fs::read_to_string(&connection_path) {
                let connection: serde_json::Value =
                    serde_json::from_str(&raw).expect("valid connection metadata");
                if let Some(url) = connection["url"].as_str() {
                    if client
                        .get(format!("{url}/api/status"))
                        .header("x-api-key", "br_shutdown_test")
                        .send()
                        .await
                        .is_ok_and(|response| response.status().is_success())
                    {
                        break url.to_string();
                    }
                }
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("broker API should become ready")
}

#[tokio::test]
async fn broker_exits_inside_node_down_window_when_registration_stalls() {
    let relaycast = MockServer::start();
    let broker_registration = relaycast.mock(|when, then| {
        when.method(POST)
            .path("/v1/agents")
            .header("authorization", "Bearer rk_shutdown_test")
            .body_contains("\"name\":\"shutdown-broker\"");
        then.status(200).json_body(json!({
            "ok": true,
            "data": {
                "id": "agent_broker",
                "workspace_id": "ws_shutdown_test",
                "name": "shutdown-broker",
                "status": "online",
                "created_at": "2026-08-16T00:00:00.000Z",
                "token": "at_live_broker"
            }
        }));
    });
    let stalled_worker_registration = relaycast.mock(|when, then| {
        when.method(POST)
            .path("/v1/agents")
            .header("authorization", "Bearer rk_shutdown_test")
            .body_contains("\"name\":\"slow-worker\"");
        then.delay(Duration::from_secs(60))
            .status(200)
            .json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_slow",
                    "workspace_id": "ws_shutdown_test",
                    "name": "slow-worker",
                    "status": "online",
                    "created_at": "2026-08-16T00:00:00.000Z",
                    "token": "at_live_slow"
                }
            }));
    });

    let runtime_dir = TempDir::new().expect("temporary broker directory");
    let mut command = Command::new(env!("CARGO_BIN_EXE_agent-relay-broker"));
    command
        .args([
            "init",
            "--name",
            "shutdown-broker",
            "--channels",
            "general",
            "--persist",
            "--api-port",
            "0",
        ])
        .current_dir(runtime_dir.path())
        .env("RELAY_API_KEY", "rk_shutdown_test")
        .env("RELAY_BASE_URL", relaycast.base_url())
        .env("RELAY_BROKER_API_KEY", "br_shutdown_test")
        .env("RELAY_AGENT_IDENTITY_KEY", "shutdown-test-identity")
        .env("AGENT_RELAY_HANDSHAKE_ATTEMPTS", "1")
        .env("AGENT_RELAY_NO_DEBUG_FILES", "1")
        .env_remove("AGENT_RELAY_WORKSPACE_KEY")
        .env_remove("RELAY_WORKSPACE_KEY")
        .env_remove("RELAY_WORKSPACES_JSON")
        .env_remove("RELAY_DEFAULT_WORKSPACE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut broker = ChildGuard {
        child: command.spawn().expect("spawn broker"),
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .expect("HTTP client");
    let api_url = wait_for_ready_api(&mut broker.child, &runtime_dir, &client).await;
    broker_registration.assert_hits(1);

    let spawn_request = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .post(format!("{api_url}/api/spawn"))
                .header("x-api-key", "br_shutdown_test")
                .json(&json!({
                    "name": "slow-worker",
                    "cli": "cat",
                    "transport": "pty"
                }))
                .send()
                .await
        }
    });
    timeout(Duration::from_secs(5), async {
        while stalled_worker_registration.hits() == 0 {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("spawn should reach the deliberately stalled registration endpoint");

    let started = Instant::now();
    kill(
        Pid::from_raw(i32::try_from(broker.child.id()).expect("broker PID fits i32")),
        Signal::SIGTERM,
    )
    .expect("send SIGTERM to broker");
    let status = timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = broker.child.try_wait().expect("read broker status") {
                break status;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("broker must exit inside node down's shutdown window");
    let elapsed = started.elapsed();

    assert!(status.success(), "broker exited unsuccessfully: {status}");
    assert!(
        elapsed < Duration::from_secs(4),
        "stalled registration delayed SIGTERM shutdown by {elapsed:?}"
    );
    stalled_worker_registration.assert_hits(1);
    let _ = timeout(Duration::from_secs(1), spawn_request).await;
}
