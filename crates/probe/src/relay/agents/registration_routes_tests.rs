//! An already-open Grok session joins without a Cloud sign-in, and a signed-in
//! session is bound to its person.
use super::{open_grok_owner, AgentOwner, CloudAccount};
use crate::relay::cloud_session::{CloudAccess, CloudError};
use crate::relay::daemon::{Config, Core, Plugins};
use crate::relay::existing_session::enablement::OpenLeaderRequest;
use crate::relay::managed_sessions::ManagedAuthority;
use crate::relay::paths::CorePaths;
use crate::relay::sessions::{DiscoveredSession, SessionDirectory};
use crate::relay::store::{SessionKind, Target};
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;

const SESSION: &str = "01a190ab-f370-7331-9f9b-5a99d6fecfda";
const REFERENCE: &str = "existing:grok:reference";

fn account(user_id: Option<&str>) -> CloudAccount {
    CloudAccount {
        site_url: "https://agentrelay.com".into(),
        workspace_id: "rw_account".into(),
        user_id: user_id.map(str::to_owned),
    }
}

#[test]
fn an_attached_install_decides_the_owner() {
    let owner = AgentOwner {
        user_id: "user-install".into(),
        workspace_id: None,
    };
    assert_eq!(
        open_grok_owner(Some(owner), Some(account(Some("user-account"))), 501),
        Some("user-install".into())
    );
}

// A build without session history never attaches an install.
#[test]
fn a_signed_in_account_owns_its_session_without_an_install() {
    assert_eq!(
        open_grok_owner(None, Some(account(Some("user-account"))), 501),
        Some("user-account".into())
    );
}

#[test]
fn an_account_whose_person_is_unknown_owns_nothing() {
    assert_eq!(open_grok_owner(None, Some(account(None)), 501), None);
}

#[test]
fn nobody_signed_in_leaves_the_session_with_the_os_user() {
    assert_eq!(
        open_grok_owner(None, None, 501),
        Some("local-user:501".into())
    );
    assert_ne!(
        open_grok_owner(None, None, 501),
        open_grok_owner(None, None, 502)
    );
}

/// One open Grok session, as `sessions.list` offers it, whose binding exists
/// once `sessions.existing.register` would have proved its leader.
struct OpenGrok {
    bound: Mutex<Option<OpenLeaderRequest>>,
}

impl OpenGrok {
    fn row() -> DiscoveredSession {
        DiscoveredSession {
            target: Target::new(SessionKind::GrokOpen, SESSION),
            title: "Reply with just the word ready".into(),
            directory: Some("/Users/me/relay-test".into()),
            updated_at_ms: None,
            live: true,
            host: None,
            holder: None,
        }
    }
}

impl SessionDirectory for OpenGrok {
    fn sessions(&self) -> Vec<DiscoveredSession> {
        vec![Self::row()]
    }

    fn auto_activation_sessions(&self) -> Vec<DiscoveredSession> {
        vec![Self::row()]
    }

    fn find_session(&self, target: &Target) -> Option<DiscoveredSession> {
        (*target == Self::row().target).then(Self::row)
    }

    fn register_existing(&self, request: OpenLeaderRequest) -> Result<DiscoveredSession, String> {
        *self.bound.lock().unwrap() = Some(request);
        Ok(Self::row())
    }

    fn route_binding(&self, _target: &Target) -> Option<String> {
        self.bound
            .lock()
            .unwrap()
            .as_ref()
            .map(|_| REFERENCE.to_owned())
    }

    fn managed_authority(&self, _target: &Target) -> Option<ManagedAuthority> {
        self.bound
            .lock()
            .unwrap()
            .as_ref()
            .map(|request| ManagedAuthority {
                workspace_id: request.workspace_id.clone(),
                owner_id: request.owner_id.clone(),
                owner_uid: request.owner_uid,
            })
    }
}

/// A sign-in nothing can name the person of: no credential to ask with.
struct UnknownPerson;

impl CloudAccess for UnknownPerson {
    fn account(&self) -> Option<CloudAccount> {
        Some(account(None))
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
}

async fn activate(
    cloud: Option<Arc<dyn CloudAccess>>,
) -> (
    Arc<OpenGrok>,
    Vec<String>,
    fake_relaycast::FakeRelaycast,
    Arc<Core>,
    tempfile::TempDir,
) {
    activate_with(move |_, plugins| {
        if let Some(cloud) = cloud {
            plugins.cloud = cloud;
        }
    })
    .await
}

async fn activate_with(
    setup: impl FnOnce(&std::path::Path, &mut Plugins),
) -> (
    Arc<OpenGrok>,
    Vec<String>,
    fake_relaycast::FakeRelaycast,
    Arc<Core>,
    tempfile::TempDir,
) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let fake = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let data = home.join("app-data");
    fake_relaycast::sign_in_store(&data, fake_relaycast::WORKSPACE_KEY, &fake.base_url);
    let directory = Arc::new(OpenGrok {
        bound: Mutex::new(None),
    });
    let mut plugins = Plugins {
        sessions: directory.clone(),
        ..Default::default()
    };
    setup(home, &mut plugins);
    let (core, _signals) = Core::with_plugins(
        Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: data,
            env: Default::default(),
            version: "test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: Default::default(),
            delivery_timing: Default::default(),
        },
        plugins,
    );
    if let Some(account) = &core.plugins.account {
        account.attach(&core);
    }
    core.rediscover_workspace();
    core.store
        .update(|store| store.auto_activate = Some(true))
        .unwrap();
    core.verify_workspace().await.unwrap();
    let failures = core.activate_new_sessions().await;
    (directory, failures, fake, core, temp)
}

// What `relay init` leaves: a local workspace, and nobody signed in.
#[tokio::test]
async fn an_open_grok_session_joins_a_signed_out_computer() {
    let (directory, failures, fake, core, _temp) = activate(None).await;
    assert!(failures.is_empty(), "{failures:?}");
    let uid = crate::relay::peer::current_uid();
    let bound = directory.bound.lock().unwrap().clone().unwrap();
    assert_eq!(bound.owner_id, format!("local-user:{uid}"));
    assert_eq!(bound.owner_uid, uid);
    assert_eq!(bound.session_id, SESSION);
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 1);
    assert!(core.store.read(|store| {
        store
            .registration_for(&OpenGrok::row().target)
            .is_some_and(|registration| registration.auto_activated == Some(true))
            && store
                .auto_activation_failures
                .as_ref()
                .is_none_or(|failures| failures.is_empty())
    }));
    // Adding it again answers through the same authority.
    assert!(core
        .register_target(&OpenGrok::row().target, None, None)
        .await
        .is_ok());
}

#[tokio::test]
async fn a_sign_in_that_has_no_person_yet_binds_nothing() {
    let (directory, failures, fake, _core, _temp) = activate(Some(Arc::new(UnknownPerson))).await;
    assert!(directory.bound.lock().unwrap().is_none());
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 0);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].contains("could not confirm who is signed in"));
}

/// A saved sign-in after a restart: the account has no person in memory and
/// Cloud refuses the held bearer until it is renewed.
struct SavedSignIn {
    site: String,
}

impl SavedSignIn {
    /// Cloud's `/auth/whoami`, on loopback.
    fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let site = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read_exact(&mut byte).is_ok() {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head);
                let (status, body) = if !head.contains("/auth/whoami") {
                    ("404 X", "{}")
                } else if head.contains("Bearer renewed") {
                    ("200 OK", r#"{"user":{"id":"user-saved"}}"#)
                } else {
                    ("401 X", "{}")
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self { site }
    }
}

impl CloudAccess for SavedSignIn {
    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: self.site.clone(),
            ..account(None)
        })
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

    fn credential(&self, refused: Option<Secret>) -> BoxFuture<'_, Option<(String, Secret)>> {
        let bearer = if refused.is_some() { "renewed" } else { "held" };
        let held = (self.site.clone(), Secret::new(bearer.to_string()));
        Box::pin(async move { Some(held) })
    }
}

#[tokio::test]
async fn a_saved_sign_in_owns_its_session_after_a_restart() {
    let (directory, failures, fake, _core, _temp) =
        activate(Some(Arc::new(SavedSignIn::start()))).await;
    assert!(failures.is_empty(), "{failures:?}");
    let bound = directory.bound.lock().unwrap().clone().unwrap();
    assert_eq!(bound.owner_id, "user-saved");
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 1);
}

// `agent-relay cloud login` alone: the core's Cloud access stays signed out.
// The CLI's session only ever stands in for a sign-in the core already holds.
#[cfg(feature = "relay-cli")]
mod cli_login {
    use super::*;
    use crate::relay::account::Account;
    use crate::relay::cloud_session::{cli_session, SignedOut};
    use crate::relay::store::CloudSession;
    use crate::relay::uploader::{NoHistoryRunner, Uploader};
    use std::path::Path;

    const SITE: &str = "https://agentrelay.com";

    fn write_cli_login(home: &Path, contents: &str) {
        let relay_home = home.join(".agentworkforce/relay");
        std::fs::create_dir_all(&relay_home).unwrap();
        std::fs::write(relay_home.join("cloud-auth.json"), contents).unwrap();
    }

    fn fresh_login() -> String {
        serde_json::json!({
            "apiUrl": format!("{SITE}/cloud"),
            "accessToken": "fake-cli-token",
            "accessTokenExpiresAt": "2099-01-01T00:00:00Z",
        })
        .to_string()
    }

    /// Account as a release build makes it: no history, so no install.
    fn account(home: &Path) -> Arc<Account> {
        let env = Default::default();
        Arc::new(Account::new(
            Some(SITE),
            home,
            &env,
            &home.join("app-data"),
            Arc::new(Uploader::new(Arc::new(NoHistoryRunner))),
        ))
    }

    async fn assert_signed_out(cloud: &dyn CloudAccess) {
        assert!(cloud.account().is_none());
        assert!(cloud.agent_owner().is_none());
        assert!(cloud.credential(None).await.is_none());
        assert!(matches!(
            cloud.request("GET", "/members".into(), None).await,
            Err(CloudError::SignedOut)
        ));
    }

    #[tokio::test]
    async fn a_cli_login_alone_leaves_cloud_access_signed_out() {
        let mut attached = None;
        let (_directory, failures, _fake, core, temp) = activate_with(|home, plugins| {
            write_cli_login(home, &fresh_login());
            let account = account(home);
            plugins.cloud = account.clone();
            plugins.account = Some(account.clone());
            attached = Some(account);
        })
        .await;
        assert!(failures.is_empty(), "{failures:?}");
        // The login is valid, so nothing here passes because it was ignored.
        let relay_home = temp.path().join(".agentworkforce/relay");
        let now = crate::relay::state::now_ms();
        assert!(cli_session(&relay_home, SITE, now).is_some());

        let account = attached.unwrap();
        assert_signed_out(account.as_ref()).await;
        assert_signed_out(&SignedOut).await;
        // Unlike `SignedOut`'s default, but the sync stops at `account()` first.
        assert!(!account.may_sync_identities());
        assert_eq!(
            account.identity_sync_generation(),
            SignedOut.identity_sync_generation()
        );

        // The same Account does sign in from a session the core holds itself.
        core.store
            .update(|store| {
                store.cloud_session = Some(CloudSession {
                    access_token: Secret::new("fake-kept-token"),
                    access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                    refresh_token: None,
                    refresh_token_expires_at: None,
                    site_url: SITE.into(),
                });
                store.cloud.as_mut().unwrap().account_workspace_id = Some("workspace".into());
            })
            .unwrap();
        assert_eq!(account.account().unwrap().site_url, SITE);
    }

    #[tokio::test]
    async fn an_open_grok_session_is_owned_the_same_without_account() {
        let (with_account, ..) = activate_with(|home, plugins| {
            write_cli_login(home, &fresh_login());
            let account = account(home);
            plugins.cloud = account.clone();
            plugins.account = Some(account);
        })
        .await;
        let (without_account, ..) =
            activate_with(|home, _| write_cli_login(home, &fresh_login())).await;

        let owner = |directory: &OpenGrok| directory.bound.lock().unwrap().clone().unwrap();
        let (kept, replaced) = (owner(&with_account), owner(&without_account));
        let uid = crate::relay::peer::current_uid();
        assert_eq!(kept.owner_id, format!("local-user:{uid}"));
        assert_eq!(kept.owner_id, replaced.owner_id);
        assert_eq!(kept.owner_uid, replaced.owner_uid);
    }

    #[tokio::test]
    async fn a_broken_or_missing_cli_login_is_signed_out_too() {
        for contents in [None, Some("not json"), Some("{}")] {
            let mut attached = None;
            let (.., _temp) = activate_with(|home, plugins| {
                if let Some(contents) = contents {
                    write_cli_login(home, contents);
                }
                let account = account(home);
                plugins.cloud = account.clone();
                plugins.account = Some(account.clone());
                attached = Some(account);
            })
            .await;
            assert_signed_out(attached.unwrap().as_ref()).await;
        }
    }
}
