//! The real relay core binary driven by the Linux app's bridge client, end
//! to end.
//!
//! Runs when `RELAY_E2E_PROBE` names a built `agent-relay-probe` (CI's
//! `linux` job builds one for each architecture); without it each case
//! passes without running. The core runs in an empty temporary home with a
//! cleared environment, against the in-process fake Relaycast and fake Agent
//! Relay Cloud on loopback: no real workspace, Cloud, Relaycast or PostHog is
//! reached, and no broker, PTY runtime or agent harness is started.
//!
//! Unix only: the hosted core runs through an `env -i` shell wrapper and the
//! headless app is stopped with SIGTERM. A Windows run needs a batch wrapper
//! and the Windows launcher's own stop (`bin/agent-relay-desktop.rs`).
#![cfg(unix)]

mod support {
    pub mod fake_cloud;
    pub mod fake_relaycast;
}

use agent_relay_probe::linux_app::bridge::{Bridge, BridgeEvent, BridgeOptions, Connection};
use agent_relay_probe::linux_app::host::HostOptions;
use agent_relay_probe::relay::protocol::BRIDGE_VERSION;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use support::fake_cloud::FakeCloud;
use support::fake_relaycast::{Behaviour, FakeRelaycast, WORKSPACE_KEY};
use tempfile::TempDir;
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(20);

/// The core under test, when CI built one.
fn probe() -> Option<PathBuf> {
    let probe = std::env::var_os("RELAY_E2E_PROBE").filter(|value| !value.is_empty());
    if probe.is_none() {
        eprintln!("skipped: set RELAY_E2E_PROBE to a built agent-relay-probe");
    }
    probe.map(PathBuf::from)
}

/// An empty home with analytics off, so even a core started for the
/// production site (the headless app) sends nothing.
struct Home {
    directory: TempDir,
    env: Vec<(&'static str, String)>,
}

impl Home {
    fn new(relaycast: &FakeRelaycast) -> Home {
        // Short, so the socket path fits sun_path.
        let directory = tempfile::Builder::new()
            .prefix("e2e-")
            .tempdir_in("/tmp")
            .unwrap();
        let home = directory.path();
        let path = |name: &str| home.join(name).display().to_string();
        let env = vec![
            ("HOME", home.display().to_string()),
            ("PATH", "/usr/bin:/bin".to_string()),
            ("XDG_CONFIG_HOME", path("config")),
            ("XDG_DATA_HOME", path("data")),
            ("XDG_CACHE_HOME", path("cache")),
            ("XDG_RUNTIME_DIR", path("run")),
            ("AGENT_RELAY_HOME", path("relay")),
        ];
        // The hosted core's `app_data_dir`.
        support::fake_relaycast::sign_in_store(
            &home.join("app-data"),
            WORKSPACE_KEY,
            &relaycast.base_url,
        );
        std::fs::create_dir(home.join("run")).unwrap();
        std::fs::set_permissions(home.join("run"), std::fs::Permissions::from_mode(0o700)).unwrap();
        let preferences = home.join("config/com.agentrelay.desktop/preferences.json");
        std::fs::create_dir_all(preferences.parent().unwrap()).unwrap();
        std::fs::write(&preferences, "{\"analytics_enabled\": false}\n").unwrap();
        Home { directory, env }
    }

    fn path(&self) -> &Path {
        self.directory.path()
    }

    fn socket(&self) -> PathBuf {
        self.path().join("core.sock")
    }

    /// `probe` run with only this home's environment, which is what the
    /// bridge hosts: a hosted core inherits the app's environment.
    fn isolated(&self, probe: &Path) -> PathBuf {
        let quote = |value: &str| format!("'{}'", value.replace('\'', r"'\''"));
        let assignments: Vec<String> = self
            .env
            .iter()
            .map(|(name, value)| format!("{name}={}", quote(value)))
            .collect();
        let script = self.path().join("core");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nexec env -i {} {} \"$@\"\n",
                assignments.join(" "),
                quote(&probe.display().to_string())
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }
}

struct Events(mpsc::Receiver<BridgeEvent>);

impl Events {
    async fn next<T>(&mut self, pick: impl Fn(BridgeEvent) -> Option<T>) -> T {
        tokio::time::timeout(WAIT, async {
            loop {
                if let Some(value) = pick(self.0.recv().await.expect("the bridge stopped")) {
                    return value;
                }
            }
        })
        .await
        .expect("no such event in time")
    }

    /// The next snapshot `matches` accepts, as JSON.
    async fn status(&mut self, matches: impl Fn(&Value) -> bool) -> Value {
        self.next(|event| match event {
            BridgeEvent::Status(status) => {
                Some(serde_json::to_value(&*status).unwrap()).filter(&matches)
            }
            _ => None,
        })
        .await
    }
}

async fn call(bridge: &Bridge, method: &str, params: Value) -> Value {
    bridge
        .call_value(method, params)
        .await
        .unwrap_or_else(|error| panic!("{method}: {error:?}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_hosts_the_core_and_drives_it() {
    let Some(probe) = probe() else { return };
    let relaycast = FakeRelaycast::start(Behaviour::default()).await;
    let cloud = FakeCloud::start().await;
    // Device sign-in stays pending until it is cancelled.
    cloud.state.lock().unwrap().pending_polls = u32::MAX;
    let home = Home::new(&relaycast);
    let socket = home.socket();
    let options = BridgeOptions {
        socket: socket.clone(),
        host: Some(HostOptions {
            probe: Some(home.isolated(&probe)),
            site_url: Some(cloud.site_url.clone()),
            app_data_dir: Some(home.path().join("app-data")),
            version: None,
        }),
        service: None,
    };
    let (bridge, events) = Bridge::start(options, &tokio::runtime::Handle::current());
    let mut events = Events(events);

    events
        .next(|event| matches!(event, BridgeEvent::Connected).then_some(()))
        .await;
    let first = events.status(|_| true).await;
    assert!(bridge.hosting());
    assert_eq!(first["account"]["state"], "signed_out");
    assert_eq!(first["daemon"]["bridge_version"], BRIDGE_VERSION);

    // The account's workspace key is found and verified with the fake
    // Relaycast; the key itself never reaches the snapshot.
    let verified = if first["workspace"]["verification"] == "verified" {
        first
    } else {
        events
            .status(|status| status["workspace"]["verification"] == "verified")
            .await
    };
    assert_eq!(verified["workspace"]["state"], "found");
    assert!(!verified.to_string().contains(WORKSPACE_KEY));

    for method in [
        "account.sign_in",
        "uploader.status",
        "sessions.list",
        "fleet.list",
        "messages.send",
        "login_item.set",
        "links.parse",
    ] {
        assert!(bridge.offers(method), "{method}");
    }
    assert_eq!(
        call(&bridge, "uploader.sessions.preview", json!({})).await,
        json!({"sessions": []})
    );
    assert_eq!(
        call(&bridge, "sessions.list", json!({})).await["sessions"],
        json!([])
    );
    assert_eq!(
        call(&bridge, "fleet.list", json!({})).await["brokers"],
        json!([])
    );
    let settings = call(&bridge, "settings.get", json!({})).await;
    assert!(settings.get("analytics_enabled").is_some(), "{settings}");

    // First-run setup's Claude Code default keeps an explicit hold and sets
    // accept only where the key is absent, keeping a backup.
    let claude = home.path().join(".claude/settings.json");
    std::fs::create_dir_all(claude.parent().unwrap()).unwrap();
    std::fs::write(&claude, r#"{"crossSessionInbound": "hold"}"#).unwrap();
    let kept = call(
        &bridge,
        "settings.set",
        json!({"direct_delivery_default": true}),
    )
    .await;
    assert_eq!(kept["direct_delivery"], false);
    assert_eq!(
        std::fs::read_to_string(&claude).unwrap(),
        r#"{"crossSessionInbound": "hold"}"#
    );
    std::fs::write(&claude, r#"{"model": "opus"}"#).unwrap();
    let accepted = call(
        &bridge,
        "settings.set",
        json!({"direct_delivery_default": true}),
    )
    .await;
    assert_eq!(accepted["direct_delivery"], true);
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&claude).unwrap()).unwrap();
    assert_eq!(
        written,
        json!({"crossSessionInbound": "accept", "model": "opus"})
    );
    assert_eq!(
        std::fs::read_to_string(
            home.path()
                .join(".claude/settings.json.relay-desktop-backup")
        )
        .unwrap(),
        r#"{"model": "opus"}"#
    );
    assert!(call(&bridge, "settings.get", json!({}))
        .await
        .get("direct_delivery_default")
        .is_none());
    assert_eq!(
        call(
            &bridge,
            "links.parse",
            json!({"url": "agentrelay://message?to=web%40desk"})
        )
        .await,
        json!({"kind": "message", "endpoint": "web@desk", "address": true})
    );

    if cfg!(target_os = "linux") {
        let entry = home.path().join("config/autostart/agent-relay.desktop");
        call(&bridge, "login_item.set", json!({"enabled": true})).await;
        assert!(entry.exists());
        assert_eq!(
            call(&bridge, "login_item.status", json!({})).await,
            json!({"enabled": true})
        );
        call(&bridge, "login_item.set", json!({"enabled": false})).await;
        assert!(!entry.exists());
    }

    // A device sign-in against the fake Cloud waits for approval, then is
    // cancelled.
    let started = call(
        &bridge,
        "account.sign_in",
        json!({"sharing": "selected", "flow": "device"}),
    )
    .await;
    assert_eq!(started["state"], "pending_approval");
    assert_eq!(started["user_code"], "ABCD-EFGH");
    assert_eq!(
        started["verification_url_complete"],
        format!("{}/device?code=ABCD-EFGH", cloud.site_url)
    );
    events
        .next(|event| match event {
            BridgeEvent::SignIn(report) => {
                (report.link.user_code.as_deref() == Some("ABCD-EFGH")).then_some(())
            }
            _ => None,
        })
        .await;
    call(&bridge, "account.sign_in.cancel", json!({})).await;
    events
        .status(|status| status["account"]["state"] == "signed_out")
        .await;
    assert!(!cloud.requests("/cloud/api/v1/auth/device/start").is_empty());

    let pid = bridge.hosted_pid().unwrap();
    bridge.stop().await;
    // The core is gone (reaped) and took its socket with it.
    assert_ne!(unsafe { libc::kill(pid as i32, 0) }, 0);
    assert!(!socket.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_headless_app_runs_the_core() {
    let Some(probe) = probe() else { return };
    let relaycast = FakeRelaycast::start(Behaviour::default()).await;
    let home = Home::new(&relaycast);
    let socket = home.socket();
    let mut app = Command::new(env!("CARGO_BIN_EXE_agent-relay-desktop"))
        .arg("--headless")
        .env_clear()
        .envs(home.env.iter().map(|(name, value)| (name, value)))
        .env("RELAY_DESKTOP_PROBE", &probe)
        .env("AGENT_RELAY_CORE_SOCKET", &socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + WAIT;
    while !socket.exists() {
        if let Some(status) = app.try_wait().unwrap() {
            let output = app.wait_with_output().unwrap();
            panic!(
                "the headless core exited ({status}): {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert!(Instant::now() < deadline, "the headless core listens");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut connection = Connection::open(&socket).await.unwrap();
    connection.greet().await.unwrap();
    let status = connection
        .request("status.get", json!({}), WAIT)
        .await
        .unwrap();
    assert_eq!(status["account"]["state"], "signed_out");
    drop(connection);

    // `--headless` replaced itself with the core, so the signal reaches it.
    assert_eq!(unsafe { libc::kill(app.id() as i32, libc::SIGTERM) }, 0);
    let deadline = Instant::now() + WAIT;
    let status = loop {
        if let Some(status) = app.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "the headless core stops");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(status.code(), Some(0));
    assert!(!socket.exists());
}
