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
use futures_util::future::BoxFuture;
use serde_json::Value;
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

/// A sign-in that has not said who the person is yet.
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
    if let Some(cloud) = cloud {
        plugins.cloud = cloud;
    }
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
    assert!(failures[0].contains("sign-in is still loading"));
}
