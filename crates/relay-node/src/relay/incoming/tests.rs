use super::*;
use crate::relay::mailbox::{CredentialFiles, MailboxCredential, MailboxSocket};
use crate::relay::outbox::{
    CodexAppServerError, CodexQueueError, CodexWindowDelivering, RolloutSummary, WindowSessionError,
};
use serde_json::json;
use std::collections::HashSet;
use std::time::Duration;

/// `incoming.status` as the bridge sends it.
fn json(status: IncomingStatus) -> Value {
    serde_json::to_value(status).unwrap()
}

const THREAD: &str = "12345678-1234-1234-1234-123456789012";

/// A Codex that takes nothing: messages wait in the outbox.
struct NoCodex;

impl CodexDeliveryEffects for NoCodex {
    fn queue_available(&self) -> bool {
        false
    }
    fn queue_send(&self, _: &str, _: &str) -> Result<(), CodexQueueError> {
        unreachable!("nothing is delivered in these tests")
    }
    fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
        None
    }
    fn queue_cleanup(&self, _: &str, _: &str) {}
    fn app_server_loaded(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn app_server_send(&self, _: &str, _: &str, _: &str) -> Result<bool, CodexAppServerError> {
        Ok(false)
    }
    fn terminal_live(&self, _: &str) -> bool {
        false
    }
    fn rollout(&self, _: &str) -> Option<RolloutSummary> {
        None
    }
    fn idle(&self, _: &str) -> bool {
        false
    }
    fn rollout_readable(&self, _: &str) -> bool {
        false
    }
    fn with_window_session(
        &self,
        _: &mut dyn FnMut(&mut dyn CodexWindowDelivering) -> Result<(), WindowSessionError>,
    ) -> Result<(), WindowSessionError> {
        Err(WindowSessionError::Bridge(
            crate::relay::outbox::CodexBridgeError::CodexNotRunning,
        ))
    }
}

/// Room and mailbox activation, polls that return nothing, and a socket
/// that never opens; a gate can hold the activation answer.
#[derive(Default)]
struct Network {
    requests: Mutex<Vec<(String, String)>>,
    hold_activation: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

const ROOM: &str = r#"{"role":"participant","relaycastBaseUrl":"https://mailbox.example","agentToken":"at_live_device"}"#;

fn session() -> Vec<u8> {
    json!({"site": "https://mailbox.example", "account_id": "membership", "workspace_id": "workspace",
           "expires_at": "2099-01-01T00:00:00Z", "messages_path": mailbox::MESSAGES_PATH,
           "acks_path": mailbox::ACKS_PATH, "threads_path": mailbox::THREADS_PATH})
    .to_string()
    .into_bytes()
}

impl MailboxNetwork for Network {
    fn request(
        &self,
        method: &'static str,
        url: String,
        _: Secret,
        _: Option<Vec<u8>>,
        _: Option<String>,
    ) -> BoxFuture<'_, Result<Vec<u8>, MailboxError>> {
        self.requests
            .lock()
            .unwrap()
            .push((method.into(), url.clone()));
        let hold = (url.ends_with("/desktop/session") && method == "POST")
            .then(|| self.hold_activation.lock().unwrap().take())
            .flatten();
        Box::pin(async move {
            if let Some(hold) = hold {
                let _ = hold.await;
            }
            if url.contains("control.example") {
                return Ok(ROOM.as_bytes().to_vec());
            }
            if url.ends_with("/desktop/session") {
                return Ok(session());
            }
            Ok(b"[]".to_vec())
        })
    }

    fn connect(
        &self,
        _: String,
        _: Secret,
    ) -> BoxFuture<'_, Result<Box<dyn MailboxSocket>, MailboxError>> {
        Box::pin(std::future::pending())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    network: Arc<Network>,
    credentials: Arc<CredentialFiles>,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        Fixture {
            credentials: Arc::new(CredentialFiles {
                root: root.join("credentials"),
            }),
            _dir: dir,
            root,
            network: Arc::default(),
        }
    }

    fn incoming(&self) -> Arc<Incoming> {
        Incoming::new(IncomingParts {
            app_data_dir: self.root.clone(),
            network: self.network.clone(),
            credentials: self.credentials.clone(),
            effects: Arc::new(NoCodex),
            threads: Arc::new(|| {
                vec![LocalThread {
                    id: THREAD.into(),
                    project: "project".into(),
                    title: "title".into(),
                    open: true,
                }]
            }),
        })
    }
}

fn target(account: &str) -> Target {
    Target {
        site_url: "https://control.example".into(),
        account_id: Some(account.into()),
        workspace_id: Some("workspace".into()),
    }
}

fn mailbox_config() -> MailboxConfig {
    MailboxConfig {
        site: "https://mailbox.example".into(),
        account_id: "membership".into(),
        workspace_id: "workspace".into(),
        messages_path: mailbox::MESSAGES_PATH.into(),
        acks_path: mailbox::ACKS_PATH.into(),
        threads_path: mailbox::THREADS_PATH.into(),
    }
}

#[tokio::test]
async fn the_mailbox_binding_survives_a_relaunch_and_sign_out_ends_it() {
    let fixture = Fixture::new();
    let first = fixture.incoming();
    first
        .activate(&target("probe-user"), &Secret::new("login"))
        .await;
    let scope = mailbox_config().scope();
    assert!(fixture.credentials.load(&scope).is_some());
    first.stop(false).await;

    let restored = fixture.incoming();
    restored.connect(&target("probe-user"), true).await;
    assert_eq!(restored.scope().await.as_deref(), Some(scope.as_str()));
    assert_eq!(json(restored.status().await)["state"], "paused");
    restored.stop(true).await;
    assert!(fixture.credentials.load(&scope).is_none());
    for _ in 0..100 {
        if fixture
            .network
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.0 == "DELETE")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let requests = fixture.network.requests.lock().unwrap().clone();
    let delete = requests
        .iter()
        .find(|r| r.0 == "DELETE")
        .expect("deactivated");
    assert!(delete
        .1
        .starts_with("https://mailbox.example/cloud/api/v1/desktop/session?"));
    let source = Incoming::source(&target("probe-user")).unwrap();
    assert!(!fixture.incoming().connection_path(&source).exists());
}

#[tokio::test]
async fn an_expired_credential_never_reaches_the_network_and_sign_out_removes_it() {
    let fixture = Fixture::new();
    let first = fixture.incoming();
    first
        .activate(&target("probe-user"), &Secret::new("login"))
        .await;
    first.stop(false).await;
    let scope = mailbox_config().scope();
    fixture
        .credentials
        .save(&MailboxCredential {
            scope: scope.clone(),
            token: Secret::new("at_live_device"),
            expires_at_ms: 1,
        })
        .unwrap();
    let before = fixture.network.requests.lock().unwrap().len();
    let restored = fixture.incoming();
    restored.connect(&target("probe-user"), false).await;
    assert_eq!(restored.scope().await, None);
    assert_eq!(json(restored.status().await)["state"], "unavailable");
    restored.stop(true).await;
    assert!(fixture.credentials.load(&scope).is_none());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(fixture.network.requests.lock().unwrap().len(), before);
}

#[tokio::test]
async fn a_sign_out_during_activation_keeps_nothing_from_it() {
    let fixture = Fixture::new();
    let (release, hold) = tokio::sync::oneshot::channel();
    *fixture.network.hold_activation.lock().unwrap() = Some(hold);
    let incoming = fixture.incoming();
    let activating = {
        let incoming = incoming.clone();
        tokio::spawn(async move { incoming.activate(&target("a"), &Secret::new("login")).await })
    };
    for _ in 0..100 {
        if fixture.network.requests.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    incoming.stop(true).await;
    let _ = release.send(());
    activating.await.unwrap();
    assert!(fixture
        .credentials
        .load(&mailbox_config().scope())
        .is_none());
    assert_eq!(incoming.scope().await, None);
    let source = Incoming::source(&target("a")).unwrap();
    assert!(!incoming.connection_path(&source).exists());
}

#[tokio::test]
async fn an_activation_whose_sign_in_is_aborted_still_finishes_and_connects() {
    let fixture = Fixture::new();
    let (release, hold) = tokio::sync::oneshot::channel();
    *fixture.network.hold_activation.lock().unwrap() = Some(hold);
    let incoming = fixture.incoming();
    let sign_in = {
        let incoming = incoming.clone();
        tokio::spawn(async move { incoming.activate(&target("a"), &Secret::new("login")).await })
    };
    for _ in 0..100 {
        if fixture.network.requests.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // A late `account.sign_in.cancel` aborts the sign-in mid-activation.
    sign_in.abort();
    let _ = sign_in.await;
    let _ = release.send(());
    for _ in 0..100 {
        incoming.connect(&target("a"), false).await;
        if incoming.scope().await.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(incoming.scope().await, Some(mailbox_config().scope()));
    incoming.stop(false).await;
}

#[tokio::test]
async fn of_two_overlapping_activations_one_mints_the_room_session() {
    let fixture = Fixture::new();
    let (release, hold) = tokio::sync::oneshot::channel();
    *fixture.network.hold_activation.lock().unwrap() = Some(hold);
    let incoming = fixture.incoming();
    let sign_in = {
        let incoming = incoming.clone();
        tokio::spawn(async move { incoming.activate(&target("a"), &Secret::new("login")).await })
    };
    for _ in 0..100 {
        if fixture.network.requests.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Supervision's activation, while the sign-in's is in flight.
    let supervision = incoming.activate(&target("a"), &Secret::new("kept")).await;
    assert_eq!(supervision, Activation::Unneeded);
    let _ = release.send(());
    assert_eq!(sign_in.await.unwrap(), Activation::Activated);
    // Once bound, a later activation has nothing to do either.
    assert_eq!(
        incoming.activate(&target("a"), &Secret::new("kept")).await,
        Activation::Unneeded
    );
    let rooms = fixture
        .network
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, url)| url.ends_with("/room/session"))
        .count();
    assert_eq!(rooms, 1);
    incoming.connect(&target("a"), false).await;
    assert_eq!(json(incoming.status().await)["state"], "connecting");
    incoming.stop(false).await;
}

#[tokio::test]
async fn without_a_credential_nothing_starts() {
    let fixture = Fixture::new();
    let incoming = fixture.incoming();
    incoming.connect(&target("a"), false).await;
    assert_eq!(incoming.scope().await, None);
    let status = json(incoming.status().await);
    assert_eq!(status["threads"], json!([]));
    assert_eq!(status["can_approve"], false);
    assert!(fixture.network.requests.lock().unwrap().is_empty());
}

fn credential_for(fixture: &Fixture, account: &str) {
    let config = Incoming::source(&target(account)).unwrap();
    fixture
        .credentials
        .save(&MailboxCredential {
            scope: config.scope(),
            token: Secret::new("desktop-session"),
            expires_at_ms: 4_102_444_800_000,
        })
        .unwrap();
}

#[tokio::test]
async fn sharing_and_the_pause_are_scoped_to_the_account() {
    let fixture = Fixture::new();
    credential_for(&fixture, "a");
    credential_for(&fixture, "b");
    let incoming = fixture.incoming();
    incoming.connect(&target("a"), false).await;
    incoming
        .share(THREAD, Some(Mode::Hold), false)
        .await
        .unwrap();
    let status = json(incoming.status().await);
    assert_eq!(status["threads"][0]["shared"], true);
    assert_eq!(status["threads"][0]["mode"], "hold");
    assert_eq!(status["can_approve"], true);
    incoming.connect(&target("a"), true).await;
    assert_eq!(json(incoming.status().await)["state"], "paused");
    incoming.connect(&target("b"), false).await;
    assert_eq!(json(incoming.status().await)["threads"][0]["shared"], false);
    incoming.connect(&target("a"), false).await;
    assert_eq!(json(incoming.status().await)["threads"][0]["mode"], "hold");
    incoming.stop(false).await;
    assert_eq!(json(incoming.status().await)["threads"], json!([]));
}

#[tokio::test]
async fn a_sharing_save_that_fails_stays_visible_and_keeps_incoming_paused() {
    let fixture = Fixture::new();
    credential_for(&fixture, "a");
    let incoming = fixture.incoming();
    incoming.connect(&target("a"), false).await;
    incoming
        .share(THREAD, Some(Mode::Auto), true)
        .await
        .unwrap();
    let scope = Incoming::source(&target("a")).unwrap().scope();
    let file = fixture
        .root
        .join("incoming")
        .join(&scope)
        .join("shares.json");
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir_all(&file).unwrap();
    assert!(incoming.share(THREAD, None, false).await.is_err());
    let status = json(incoming.status().await);
    assert_eq!(status["state"], "paused");
    assert_eq!(status["can_approve"], false);
    assert!(status["error"]
        .as_str()
        .unwrap()
        .contains("Could not save sharing"));
    assert_eq!(incoming.approve("no-message").await, Ok(false));
}

#[tokio::test]
async fn a_frame_after_invalidation_is_neither_stored_nor_refused() {
    let fixture = Fixture::new();
    credential_for(&fixture, "a");
    let incoming = fixture.incoming();
    incoming.connect(&target("a"), false).await;
    incoming
        .share(THREAD, Some(Mode::Hold), false)
        .await
        .unwrap();
    let (inbox, lifecycle) = {
        let state = incoming.state.lock().await;
        let active = state.active.as_ref().unwrap();
        (active.inbox.clone(), active.lifecycle.clone())
    };
    let accept = Accept {
        inbox: inbox.clone(),
        lifecycle: lifecycle.clone(),
    };
    let message = json!({"id": "late", "thread_id": THREAD, "text": "hi",
        "sender": {"id": "alice", "display_name": "Alice"}, "created_at": crate::relay::cloud_session::iso(crate::relay::state::now_ms())});
    lifecycle.invalidate();
    assert_eq!(
        accept.receive_durably(&message),
        Err(MailboxError::Cancelled)
    );
    assert!(inbox.held_messages().unwrap().is_empty());
    // The next connection receives it afresh rather than replaying a refusal.
    incoming.stop(false).await;
    incoming.connect(&target("a"), false).await;
    let (inbox, lifecycle) = {
        let state = incoming.state.lock().await;
        let active = state.active.as_ref().unwrap();
        (active.inbox.clone(), active.lifecycle.clone())
    };
    Accept {
        inbox: inbox.clone(),
        lifecycle,
    }
    .receive_durably(&message)
    .unwrap();
    assert_eq!(inbox.held_messages().unwrap()[0].id, "late");
    let status = json(incoming.status().await);
    assert_eq!(status["held"][0]["id"], "late");
    assert_eq!(status["held"][0]["sender_name"], "Alice");
}

#[test]
fn the_catalog_marks_shared_threads_and_their_mode() {
    let policy = CodexSharingPolicy::in_memory();
    policy.share(THREAD, Mode::Hold, false).unwrap();
    let threads = vec![
        LocalThread {
            id: THREAD.into(),
            project: "p".into(),
            title: "t".into(),
            open: true,
        },
        LocalThread {
            id: "87654321-4321-4321-4321-210987654321".into(),
            project: "q".into(),
            title: "secret".into(),
            open: false,
        },
    ];
    let rows = catalog(&threads, &policy);
    assert_eq!(rows[0].mode.as_deref(), Some("hold"));
    assert!(rows[0].shared);
    assert!(!rows[1].shared);
    assert_eq!(mailbox::shared_catalog(rows).len(), 1);
}

#[tokio::test]
async fn a_binding_that_cannot_be_saved_leaves_no_credential_behind() {
    let fixture = Fixture::new();
    let incoming = fixture.incoming();
    let source = Incoming::source(&target("a")).unwrap();
    std::fs::create_dir_all(incoming.connection_path(&source)).unwrap();
    incoming.activate(&target("a"), &Secret::new("login")).await;
    assert!(fixture
        .credentials
        .load(&mailbox_config().scope())
        .is_none());
    for _ in 0..100 {
        if fixture
            .network
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.0 == "DELETE")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(fixture
        .network
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.0 == "DELETE"));
}

#[tokio::test]
async fn an_unreadable_binding_is_removed_and_nothing_starts() {
    let fixture = Fixture::new();
    credential_for(&fixture, "a");
    let incoming = fixture.incoming();
    let path = incoming.connection_path(&Incoming::source(&target("a")).unwrap());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"not json").unwrap();
    incoming.connect(&target("a"), false).await;
    assert_eq!(incoming.scope().await, None);
    assert!(!path.exists());
}
