//! A gate-only install's spawn node reaches Control's bridge with the
//! relay-node credential the desktop minted (`CloudAccess::
//! relay_node_credential`). It lives in the node's configuration alone:
//! never in the workspace, the store or anything else saved.

use super::*;
use crate::relay::cloud_session::{
    AgentOwner, CloudAccess, CloudAccount, CloudError, RelayNodeCredential,
};
use crate::relay::spawn::node::{NodeConfig, GATE_ONLY_UNAVAILABLE};
use futures_util::future::BoxFuture;

const TOKEN: &str = "sh_wk_fixture_desktop_minted";
/// Nothing listens: a node started here never reaches anything.
const CONTROL: &str = "http://127.0.0.1:9";
const GATE: &str = "http://127.0.0.1:19";

/// A signed-out desktop that holds what `held` says for the node.
struct Desktop {
    held: Mutex<Result<RelayNodeCredential, Option<String>>>,
}

impl Desktop {
    fn holding(held: Result<RelayNodeCredential, Option<String>>) -> Arc<Desktop> {
        Arc::new(Desktop {
            held: Mutex::new(held),
        })
    }

    fn hold(&self, held: Result<RelayNodeCredential, Option<String>>) {
        *self.held.lock().unwrap() = held;
    }
}

impl CloudAccess for Desktop {
    fn account(&self) -> Option<CloudAccount> {
        None
    }

    fn agent_owner(&self) -> Option<AgentOwner> {
        None
    }

    fn request(
        &self,
        _: &'static str,
        _: String,
        _: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        Box::pin(async { Err(CloudError::SignedOut) })
    }

    fn relay_node_credential(&self) -> Result<RelayNodeCredential, Option<String>> {
        self.held.lock().unwrap().clone()
    }
}

fn minted(node_name: &str) -> RelayNodeCredential {
    RelayNodeCredential {
        control_url: format!("{CONTROL}/"),
        node_name: node_name.into(),
        token: Secret::new(TOKEN),
    }
}

/// A core whose account workspace is gate-only (`gate`), or the key-mode
/// one `core_with` signs in with when `gate` is `None`.
fn desktop_core(home: &std::path::Path, desktop: Arc<Desktop>, gate: Option<&str>) -> Arc<Core> {
    let core = core_with(home, Arc::new(FakeSpawner::default()), desktop);
    if let Some(gate) = gate {
        core.store
            .update(|store| {
                store.cloud = Some(crate::relay::store::CloudWorkspace {
                    key: Secret::default(),
                    base_url: gate.into(),
                    gate_url: Some(gate.into()),
                    ..Default::default()
                })
            })
            .unwrap();
    }
    core.rediscover_workspace();
    assert_eq!(
        core.workspace().map(|w| w.is_gate_only()),
        Some(gate.is_some())
    );
    core
}

/// Every file under `dir`, read.
fn everything_written(dir: &std::path::Path) -> String {
    let mut text = String::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return text;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            text.push_str(&everything_written(&path));
        } else if let Ok(bytes) = std::fs::read(&path) {
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    text
}

#[tokio::test]
async fn a_gate_only_node_uses_the_desktops_relay_node_credential() {
    let home = tempfile::tempdir().unwrap();
    let desktop = Desktop::holding(Ok(minted("desk-bound")));
    let core = desktop_core(home.path(), desktop, Some(GATE));

    let config = core.wanted_spawn_node().expect("a bridged node");
    assert_eq!(config.workspace_key.expose(), TOKEN);
    // A bare origin, as every Control URL is kept.
    assert_eq!(config.control_url.as_deref(), Some(CONTROL));
    // Control bound the credential to this name.
    assert_eq!(config.node_name, "desk-bound");
    // The gate stays the base URL.
    assert_eq!(config.base_url, GATE);
    // The desktop's: Control refusing it stops and marks the node.
    assert!(config.desktop_credential);

    // The workspace never carries it, and nothing saved holds it.
    let workspace = core.workspace().unwrap();
    assert_eq!(workspace.key.expose(), "");
    assert_eq!(workspace.control_url, None);
    assert!(!format!("{workspace:?} {config:?}").contains("fixture_desktop"));
    assert!(!everything_written(home.path()).contains(TOKEN));
}

#[tokio::test]
async fn a_credential_bound_to_no_name_keeps_the_computers_node_name() {
    let home = tempfile::tempdir().unwrap();
    let core = desktop_core(home.path(), Desktop::holding(Ok(minted("  "))), Some(GATE));
    let config = core.wanted_spawn_node().unwrap();
    assert_eq!(config.node_name, node_name(&core.machine_prefix));
}

#[tokio::test]
async fn the_desktops_reason_says_why_a_gate_only_computer_cannot_spawn() {
    let home = tempfile::tempdir().unwrap();
    let desktop = Desktop::holding(Err(Some(
        "  sign in to Agent Relay again to spawn agents here. ".into(),
    )));
    let core = desktop_core(home.path(), desktop.clone(), Some(GATE));
    assert_eq!(
        core.wanted_spawn_node().unwrap_err().as_deref(),
        Some(
            "Spawning is unavailable on this computer: sign in to Agent Relay again to spawn agents here."
        )
    );
    // No credential and no reason: the gate-only reason, as before.
    for held in [Err(None), Err(Some(" ".into()))] {
        desktop.hold(held);
        assert_eq!(
            core.wanted_spawn_node().unwrap_err().as_deref(),
            Some(GATE_ONLY_UNAVAILABLE)
        );
    }
    assert!(GATE_ONLY_UNAVAILABLE.starts_with("Spawning is unavailable on this computer: "));
}

/// Something that is not a relay-node credential, or a Control URL that is
/// not a bare https origin, starts no node that would fail its enrolment.
#[tokio::test]
async fn an_unusable_credential_is_no_credential() {
    let home = tempfile::tempdir().unwrap();
    let desktop = Desktop::holding(Err(None));
    let core = desktop_core(home.path(), desktop.clone(), Some(GATE));
    for unusable in [
        RelayNodeCredential {
            token: Secret::new("rk_live_not_a_node_key"),
            ..minted("desk")
        },
        RelayNodeCredential {
            token: Secret::default(),
            ..minted("desk")
        },
        RelayNodeCredential {
            control_url: "https://control.corp.test/v1".into(),
            ..minted("desk")
        },
        RelayNodeCredential {
            control_url: "http://control.corp.test".into(),
            ..minted("desk")
        },
        RelayNodeCredential {
            control_url: String::new(),
            ..minted("desk")
        },
    ] {
        desktop.hold(Ok(unusable));
        assert_eq!(
            core.wanted_spawn_node().unwrap_err().as_deref(),
            Some(GATE_ONLY_UNAVAILABLE)
        );
    }
}

/// Without a relaygate URL the desktop's credential is never read: the node
/// is the workspace key's, under the computer's own name, as before.
#[tokio::test]
async fn key_mode_ignores_the_desktops_relay_node_credential() {
    for held in [
        Ok(minted("desk-bound")),
        Err(Some("not for a key-mode install".into())),
        Err(None),
    ] {
        let home = tempfile::tempdir().unwrap();
        let core = desktop_core(home.path(), Desktop::holding(held), None);
        let config = core.wanted_spawn_node().expect("a key-mode node");
        assert_eq!(config.workspace_key.expose(), "rk_live_test0000");
        assert_eq!(config.control_url, None);
        assert_eq!(config.node_name, node_name(&core.machine_prefix));
        assert_eq!(config.base_url, "http://localhost:9");
        assert!(!config.desktop_credential);
    }
}

/// The desktop mints, replaces or forgets its credential while the
/// workspace stays the same; each rediscovery brings the node in line.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rediscovery_follows_the_desktops_credential() {
    let home = tempfile::tempdir().unwrap();
    let desktop = Desktop::holding(Err(Some("sign in again.".into())));
    let core = desktop_core(home.path(), desktop.clone(), Some(GATE));
    let spawn_error = |core: &Core| core.status().spawn.and_then(|spawn| spawn.error);
    let reason = "Spawning is unavailable on this computer: sign in again.";
    eventually(|| spawn_error(&core).as_deref() == Some(reason)).await;

    desktop.hold(Ok(minted("desk-bound")));
    core.rediscover_workspace();
    eventually_async(&core, |config| {
        config.is_some_and(|c| c.workspace_key.expose() == TOKEN && c.node_name == "desk-bound")
    })
    .await;

    // Re-minted under the same name: the node is replaced with the new one.
    desktop.hold(Ok(RelayNodeCredential {
        token: Secret::new("sh_wk_fixture_reminted"),
        ..minted("desk-bound")
    }));
    core.rediscover_workspace();
    eventually_async(&core, |config| {
        config.is_some_and(|c| c.workspace_key.expose() == "sh_wk_fixture_reminted")
    })
    .await;

    // Forgotten: the node stops and the desktop's reason is shown.
    desktop.hold(Err(Some(
        "its credential was refused; signing in again.".into(),
    )));
    core.rediscover_workspace();
    eventually_async(&core, |config| config.is_none()).await;
    eventually(|| {
        spawn_error(&core).as_deref()
            == Some(
                "Spawning is unavailable on this computer: its credential was refused; signing in again.",
            )
    })
    .await;
    assert!(!everything_written(home.path()).contains("sh_wk_fixture"));
    core.stop_spawn_node().await;
}

async fn eventually(done: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "never happened");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits until the running node's configuration (`None` for none) is `done`.
async fn eventually_async(core: &Core, done: impl Fn(Option<&NodeConfig>) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if done(
            core.spawn_node
                .lock()
                .await
                .as_ref()
                .map(|node| node.config()),
        ) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the node never followed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
